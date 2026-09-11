"""端口与决策类型的契约测试。"""

import pytest
from pydantic import TypeAdapter, ValidationError

from personal_agent.model_gateway import (
    ModelContext,
    ModelDecision,
    ModelGateway,
    Observation,
    ScriptExhausted,
    SummaryDecision,
    ToolCallDecision,
)

adapter = TypeAdapter(ModelDecision)


def test_discriminated_union_parses_tool_call():
    d = adapter.validate_python(
        {
            "kind": "tool_call",
            "callId": "c-1",
            "capability": "filesystem.list",
            "arguments": {"rootId": "downloads"},
        }
    )
    assert isinstance(d, ToolCallDecision)
    assert d.capability == "filesystem.list"
    assert d.arguments == {"rootId": "downloads"}


def test_discriminated_union_parses_summary():
    d = adapter.validate_python({"kind": "summary", "facts": [{"text": "a"}]})
    assert isinstance(d, SummaryDecision)
    assert d.facts == [{"text": "a"}]


def test_unknown_kind_is_rejected():
    with pytest.raises(ValidationError):
        adapter.validate_python({"kind": "delete_everything"})


def test_missing_kind_is_rejected():
    """没有 discriminator 字段时不能靠「猜哪个像」蒙过去。

    判别联合的价值就在这里：逐个 try 解析只能给出「哪个都不像」，
    discriminator 会把报错精确指向 kind 缺失。
    """
    with pytest.raises(ValidationError):
        adapter.validate_python({"callId": "c-1", "capability": "filesystem.list"})


def test_tool_call_rejects_empty_capability():
    """空 capability 必须在类型层就被拒。

    否则它会一路走到 TS 侧 Retriever 才被判「未注册」，
    错误现场离错误源头隔了一个进程。
    """
    with pytest.raises(ValidationError):
        adapter.validate_python({"kind": "tool_call", "callId": "c-1", "capability": ""})


def test_tool_call_rejects_empty_call_id():
    with pytest.raises(ValidationError):
        adapter.validate_python(
            {"kind": "tool_call", "callId": "", "capability": "filesystem.list"}
        )


def test_model_context_defaults_to_no_capabilities():
    """默认空列表而不是 None。

    Scope 为空是合法状态（什么都看不见），用 None 会逼每个调用点判空，
    而漏判一处就是 AttributeError。
    """
    ctx = ModelContext(taskGoal="整理 Downloads")
    assert ctx.visibleCapabilities == []


def test_model_context_defaults_to_no_observations():
    """第一步决策时历史必然是空的，默认空列表而不是 None。"""
    ctx = ModelContext(taskGoal="整理 Downloads")
    assert ctx.observations == []


def test_model_context_accepts_observations_from_dicts():
    ctx = ModelContext(
        taskGoal="g",
        observations=[
            {
                "callId": "call-1",
                "capability": "filesystem.list",
                "ok": True,
                "payload": {"entries": []},
            }
        ],
    )
    assert isinstance(ctx.observations[0], Observation)
    assert ctx.observations[0].callId == "call-1"


def test_observation_rejects_empty_call_id():
    """callId 是模型把「我上一步要求的那个调用」和结果对上的唯一凭据。

    空着的话两条观察就分不清谁是谁，模型会把 A 工具的结果当 B 工具的读。
    """
    with pytest.raises(ValidationError):
        Observation(callId="", capability="filesystem.list", ok=True)


def test_observation_rejects_empty_capability():
    with pytest.raises(ValidationError):
        Observation(callId="call-1", capability="", ok=True)


def test_observation_ok_is_required():
    """ok 不给默认值。

    默认 False 的话，engine 漏传 ok 会变成「工具失败了」被喂给模型，
    模型会换路子重试一个其实已经成功的调用 —— 而这一切不报错。
    """
    with pytest.raises(ValidationError):
        Observation(callId="call-1", capability="filesystem.list")


def test_observation_payload_defaults_to_empty_dict():
    o = Observation(callId="call-1", capability="filesystem.list", ok=True)
    assert o.payload == {}


def test_script_exhausted_carries_step_count():
    err = ScriptExhausted(3)
    assert err.steps == 3
    assert "3" in str(err)


def test_protocol_isinstance_only_checks_method_name():
    """钉住 runtime_checkable 的局限：签名完全错也能通过 isinstance。

    Python 的 Protocol 给不了 TS `implements` 那种编译期全签名检查。
    这条测试不是认可 Wrong 可用，而是把「isinstance 通过 ≠ 实现正确」
    写进测试，防止将来有人拿它当端口一致性的证明。
    真正的签名检查要靠 pyright/mypy，项目当前未装。
    """

    class Wrong:
        def decide(self):  # 少 context 参数，返回类型也不对
            return None

    assert isinstance(Wrong(), ModelGateway)
