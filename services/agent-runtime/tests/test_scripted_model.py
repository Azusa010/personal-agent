"""ScriptedModel 的行为测试。"""

import json

import pytest

from personal_agent.model_gateway import (
    ModelContext,
    ModelGateway,
    ScriptExhausted,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.scripted_model import ScriptedModel, ScriptLoadError, load_script


def golden_path() -> list:
    """TASK-013 Validation 要求的 list→extract→summary 三步。"""
    return [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem.list",
            arguments={"rootId": "downloads"},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="c-2",
            capability="document.extract_pdf",
            arguments={"path": "D:/downloads/a.pdf"},
        ),
        SummaryDecision(kind="summary", facts=[{"text": "摘要", "pageRefs": [1]}]),
    ]


def ctx() -> ModelContext:
    return ModelContext(
        taskGoal="整理 Downloads 里的 PDF",
        visibleCapabilities=["filesystem.list", "document.extract_pdf"],
    )


def test_returns_decisions_in_scripted_order():
    m = ScriptedModel(golden_path())
    got = [m.decide(ctx()) for _ in range(3)]
    assert [d.kind for d in got] == ["tool_call", "tool_call", "summary"]
    assert [d.callId for d in got[:2]] == ["c-1", "c-2"]


def test_raises_when_script_exhausted():
    m = ScriptedModel(golden_path())
    for _ in range(3):
        m.decide(ctx())
    with pytest.raises(ScriptExhausted) as ei:
        m.decide(ctx())
    assert ei.value.steps == 3


def test_exhaustion_does_not_silently_repeat_last_decision():
    """耗尽后不能重复返回最后一个决策。

    如果重复，AgentEngine 的循环就没有终止条件：
    模型永远说「我给摘要」，engine 永远收不到结束信号，
    TEST-012 的 20/20 只能靠超时失败——那是最难查的一类红。
    """
    m = ScriptedModel(golden_path())
    for _ in range(3):
        m.decide(ctx())
    assert m.remaining == 0
    with pytest.raises(ScriptExhausted):
        m.decide(ctx())


def test_records_received_contexts():
    """receivedContexts 是测试探针：证明 engine 真传了上下文，而不是传 None 也能绿。"""
    m = ScriptedModel(golden_path())
    c = ctx()
    m.decide(c)
    m.decide(c)
    assert len(m.receivedContexts) == 2
    assert m.receivedContexts[0].taskGoal == "整理 Downloads 里的 PDF"


def test_constructor_copies_input_sequence():
    """改原列表不能影响已构造的实例。

    不复制的话，REQ-010 的 20 次 Golden Path 循环会共用同一个可变列表，
    第一次跑完就被清空，第 2 次直接 ScriptExhausted——而且是间歇性的。
    """
    script = golden_path()
    m = ScriptedModel(script)
    script.clear()
    assert m.remaining == 3
    assert m.decide(ctx()).kind == "tool_call"


def test_remaining_counts_down():
    m = ScriptedModel(golden_path())
    assert m.remaining == 3
    m.decide(ctx())
    assert m.remaining == 2


def test_two_instances_do_not_share_cursor():
    """20 次循环要 new 20 个实例，或者复用同一个——两条路都得能走。

    这条钉住游标是实例级而非类级：写成类属性会让 20 次循环从第 2 次起全废。
    """
    a = ScriptedModel(golden_path())
    b = ScriptedModel(golden_path())
    a.decide(ctx())
    a.decide(ctx())
    assert a.remaining == 1
    assert b.remaining == 3


def test_satisfies_model_gateway_protocol():
    m = ScriptedModel(golden_path())
    assert isinstance(m, ModelGateway)


# ====== 剧本加载（TASK-016）======

SCRIPT = [
    {
        "kind": "tool_call",
        "callId": "c-1",
        "capability": "filesystem.list",
        "arguments": {"rootId": "downloads"},
    },
    {"kind": "summary", "facts": [{"text": "摘要", "pageRefs": [1]}]},
]


def write_script(tmp_path, payload, name="script.json"):
    path = tmp_path / name
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return path


def test_load_script_returns_decisions_in_file_order(tmp_path):
    assert load_script(write_script(tmp_path, SCRIPT)) == [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem.list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(kind="summary", facts=[{"text": "摘要", "pageRefs": [1]}]),
    ]


def test_load_script_accepts_str_and_path_alike(tmp_path):
    # 调用方从 env 拿到的是 str，测试里习惯传 Path，两边都得收。
    path = write_script(tmp_path, SCRIPT)
    assert load_script(str(path)) == load_script(path)


def test_load_script_keeps_unicode_text(tmp_path):
    assert load_script(write_script(tmp_path, SCRIPT))[1].facts[0]["text"] == "摘要"


def test_load_script_missing_file_raises_script_load_error(tmp_path):
    with pytest.raises(ScriptLoadError):
        load_script(tmp_path / "不存在.json")


def test_load_script_broken_json_raises_script_load_error(tmp_path):
    with pytest.raises(ScriptLoadError):
        load_script(write_script(tmp_path, "{ 这不是 JSON"))


def test_load_script_top_level_not_a_list_raises(tmp_path):
    # 顶层是对象时逐项校验会去迭代 dict 的键，报出来的错会指向字符串而不是形状。
    with pytest.raises(ScriptLoadError):
        load_script(write_script(tmp_path, {"kind": "summary"}))


def test_load_script_unknown_kind_raises(tmp_path):
    with pytest.raises(ScriptLoadError):
        load_script(write_script(tmp_path, [{"kind": "闲聊"}]))


def test_load_script_item_missing_required_field_raises(tmp_path):
    with pytest.raises(ScriptLoadError):
        load_script(
            write_script(tmp_path, [{"kind": "tool_call", "capability": "filesystem.list"}])
        )


def test_load_script_error_message_names_the_file(tmp_path):
    # 启动时读不到剧本只记一条日志，日志里没有路径就只能猜是哪个环境变量指错了。
    path = tmp_path / "不存在.json"
    with pytest.raises(ScriptLoadError, match="不存在.json"):
        load_script(path)


def test_load_script_empty_list_is_legal(tmp_path):
    # 空剧本不是坏剧本：它会跑出 ScriptExhausted，那是 engine 该接的，
    # 加载层不替它做判断。
    assert load_script(write_script(tmp_path, [])) == []
