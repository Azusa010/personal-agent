"""ScriptedModel 的行为测试。"""

import pytest

from personal_agent.model_gateway import (
    ModelContext,
    ModelGateway,
    ScriptExhausted,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.scripted_model import ScriptedModel


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
