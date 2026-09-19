"""LiveModel 的行为测试（TASK-027）。

真 client 一构造就要 API Key、一调用就出网，这两件事都不该进单元测试，
所以全部用假 client：这里钉的是适配器的**翻译层**——ModelContext 怎么变成
请求、模型的文本怎么变回 ModelDecision、用量怎么记账、失败怎么收场。
真实网络行为不在本文件的覆盖范围（CON-006：CI 不得依赖真实模型）。
"""

import json
from typing import Any, get_args

import pytest

from personal_agent.live_model import (
    DECISION_SCHEMA,
    INSTRUCTIONS,
    LIVE_MODEL_ENV,
    TOOL_SPECS,
    LiveModel,
    compose_instructions,
    render_input,
)
from personal_agent.model_gateway import (
    ModelCallFailed,
    ModelContext,
    Observation,
    ReplanDecision,
    StepCompleteDecision,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.protocol.models import CapabilityId, PlanStepDto, ProfileDto, Turn

VISIBLE = ["filesystem.list", "document.extract_pdf"]


class FakeUsage:
    def __init__(self, input_tokens=0, output_tokens=0):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class FakeResponse:
    def __init__(self, text: str, usage: Any = None):
        self.output_text = text
        self.usage = usage


class FakeStreamEvent:
    def __init__(self, type: str, delta: str = "") -> None:
        self.type = type
        self.delta = delta


class FakeStream:
    def __init__(self, events: list[Any], final_response: Any) -> None:
        self._events = events
        self._final_response = final_response

    def __iter__(self):
        return iter(self._events)

    def get_final_response(self) -> Any:
        return self._final_response


class FakeStreamManager:
    def __init__(self, events: list[Any], final_response: Any) -> None:
        self._events = events
        self._final_response = final_response

    def __enter__(self) -> FakeStream:
        return FakeStream(self._events, self._final_response)

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        pass


class FakeResponses:
    def __init__(self, items: list[Any], stream_events: list[Any] | None = None):
        self._items = list(items)
        self.requests: list[dict[str, Any]] = []
        self.stream_requests: list[dict[str, Any]] = []
        self._stream_events = list(stream_events or [])

    def create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        item = self._items.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def stream(self, **kwargs: Any) -> Any:
        self.stream_requests.append(kwargs)
        item = self._items.pop(0)
        if isinstance(item, Exception):
            raise item
        return FakeStreamManager(self._stream_events, item)


class FakeClient:
    def __init__(self, items: list[Any], stream_events: list[Any] | None = None):
        self.responses = FakeResponses(items, stream_events)


def tool_call_json(call_id="call-1", capability="filesystem.list", **arguments):
    return json.dumps(
        {
            "kind": "tool_call",
            "callId": call_id,
            "capability": capability,
            "arguments": arguments or {"rootId": "downloads"},
        }
    )


def summary_json(facts=None, reply="已完成，结论如下。"):
    return json.dumps(
        {
            "kind": "summary",
            "reply": reply,
            "facts": facts if facts is not None else [{"text": "p1 说了 A", "pageRefs": [1]}],
        }
    )


def context_with(
    observations: list[Observation] | None = None,
    plan: list[PlanStepDto] | None = None,
    history: list[Turn] | None = None,
) -> ModelContext:
    return ModelContext(
        taskGoal="整理 Downloads 里的 PDF",
        visibleCapabilities=VISIBLE,
        observations=observations or [],
        plan=plan or [],
        history=history or [],
    )


def test_tool_specs_only_names_registered_capabilities():
    # 提示语里的能力名必须落在协议枚举内：写错了只是模型收到一条错提示，
    # 不会报错，所以在这里钉住。
    assert set(TOOL_SPECS) <= set(get_args(CapabilityId))


def test_decision_schema_is_derived_from_the_contract():
    # schema 从 ModelDecision 派生（不手抄）：判别键与四个分支都要在。
    assert DECISION_SCHEMA["discriminator"]["propertyName"] == "kind"
    assert set(DECISION_SCHEMA["discriminator"]["mapping"]) == {
        "tool_call",
        "summary",
        "step_complete",
        "replan",
    }


def test_render_input_lists_goal_capabilities_and_observations():
    rendered = render_input(
        context_with(
            [
                Observation(
                    callId="call-1",
                    capability="filesystem.list",
                    ok=True,
                    payload={"entries": [{"name": "a.pdf"}]},
                ),
                Observation(
                    callId="call-2",
                    capability="document.extract_pdf",
                    ok=False,
                    payload={"code": "PDF_UNREADABLE", "reason": "坏了"},
                ),
            ]
        )
    )

    assert "整理 Downloads 里的 PDF" in rendered
    assert "- filesystem.list: " in rendered
    assert "- document.extract_pdf: " in rendered
    assert "call-1" in rendered and "a.pdf" in rendered
    # 失败也要进上下文：模型得知道这一步没成，才不会照着不存在的页面写摘要。
    assert "ok=False" in rendered and "PDF_UNREADABLE" in rendered
    # 中文 payload 不能被转义成 \uXXXX：ensure_ascii=False 掉了会降低模型可读性。
    assert "坏了" in rendered


def test_render_input_skips_capabilities_outside_the_visible_list():
    context = ModelContext(
        taskGoal="g",
        visibleCapabilities=["filesystem.list"],
        observations=[],
    )

    rendered = render_input(context)

    assert "filesystem.list" in rendered
    assert "document.extract_pdf" not in rendered
    assert "（还没有调用过任何工具）" in rendered


def test_render_input_renders_the_plan_in_order():
    rendered = render_input(
        context_with(
            plan=[
                PlanStepDto(
                    description="列出 Downloads 下的 PDF", capability="filesystem.list"
                ),
                PlanStepDto(description="基于页面内容生成带页码引用的摘要"),
            ]
        )
    )

    # 计划带顺序编号；不经工具的那一步要有明确标注——模型得知道「这一步不调
    # 工具，直接给摘要」，否则它会试图为摘要步编一个能力名出来。
    assert "1. 列出 Downloads 下的 PDF（filesystem.list）" in rendered
    assert "2. 基于页面内容生成带页码引用的摘要（不经工具，最后直接回复用户）" in rendered


def test_render_input_with_an_empty_plan_says_so():
    # 生产路径上 Main 必发 plan（契约 min(1)）；空计划只可能来自替身测试。
    # 渲染不该崩，也不该留下一个没有内容的「本轮计划：」悬空标题。
    rendered = render_input(context_with())

    assert "本轮计划" in rendered
    assert "（空）" in rendered


def test_render_input_renders_the_history_for_coreference():
    # 执行侧同样要看得见之前聊了什么：计划是「做什么」，历史补齐「指什么」。
    rendered = render_input(
        context_with(history=[Turn(role="user", text="把最新的 PDF 整理到 Reading")])
    )

    assert "之前的对话" in rendered
    assert "[user] 把最新的 PDF 整理到 Reading" in rendered


def test_render_input_omits_the_history_section_on_the_first_turn():
    rendered = render_input(context_with())

    assert "之前的对话" not in rendered


def test_instructions_no_longer_hardcode_the_golden_path():
    # 写死五步是「只能固定执行」的根因之一：提示词里不许再出现具体的步骤序列、
    # 能力名或目标目录名——这一轮做什么，只由输入里的「本轮计划」说了算。
    assert "Reading" not in INSTRUCTIONS
    assert "Downloads" not in INSTRUCTIONS
    for capability in get_args(CapabilityId):
        assert capability not in INSTRUCTIONS


def test_decide_sends_the_contract_schema_and_returns_a_tool_call():
    client = FakeClient([FakeResponse(tool_call_json(), FakeUsage(11, 3))])
    model = LiveModel(model="gpt-test", client=client)

    decision = model.decide(context_with())

    assert isinstance(decision, ToolCallDecision)
    assert decision.capability == "filesystem.list"
    assert decision.arguments == {"rootId": "downloads"}
    request = client.responses.requests[0]
    assert request["model"] == "gpt-test"
    assert request["instructions"] == INSTRUCTIONS
    assert request["text"]["format"]["schema"] == DECISION_SCHEMA
    # strict=True 会拒掉 arguments / facts 这类自由对象，必须显式关掉。
    assert request["text"]["format"]["strict"] is False
    # 本地优先：PDF 内容不留在服务端。
    assert request["store"] is False


def test_decide_returns_a_summary_decision():
    client = FakeClient(
        [FakeResponse(summary_json([{"text": "第一页讲了 A", "pageRefs": [1, 2]}]))]
    )
    model = LiveModel(model="gpt-test", client=client)

    decision = model.decide(context_with())

    assert isinstance(decision, SummaryDecision)
    assert decision.facts == [{"text": "第一页讲了 A", "pageRefs": [1, 2]}]


def test_decide_returns_step_complete_decision():
    client = FakeClient(
        [FakeResponse(json.dumps({"kind": "step_complete", "result": "第一步已提取完成"}))]
    )
    model = LiveModel(model="gpt-test", client=client)

    decision = model.decide(context_with())

    assert isinstance(decision, StepCompleteDecision)
    assert decision.result == "第一步已提取完成"


def test_decide_returns_replan_decision():
    client = FakeClient(
        [FakeResponse(json.dumps({"kind": "replan", "reason": "文件已加密无法读取"}))]
    )
    model = LiveModel(model="gpt-test", client=client)

    decision = model.decide(context_with())

    assert isinstance(decision, ReplanDecision)
    assert decision.reason == "文件已加密无法读取"


def test_decide_survives_a_response_without_usage():
    # usage 缺失按 0 记，任务照常继续：少了统计不该让任务失败。
    client = FakeClient([FakeResponse(tool_call_json())])
    model = LiveModel(model="gpt-test", client=client)

    model.decide(context_with())

    usage = model.usage_snapshot()
    assert usage is not None
    assert (usage.inputTokens, usage.outputTokens, usage.calls) == (0, 0, 1)


def test_usage_snapshot_is_none_before_any_call():
    # 没花 token 的任务不该凭空多一条零用量事件（engine 据此决定加不加）。
    model = LiveModel(model="gpt-test", client=FakeClient([]))

    assert model.usage_snapshot() is None


def test_usage_snapshot_accumulates_across_calls():
    client = FakeClient(
        [
            FakeResponse(tool_call_json("call-1"), FakeUsage(10, 2)),
            FakeResponse(tool_call_json("call-2", capability="document.extract_pdf"), FakeUsage(20, 5)),
            FakeResponse(summary_json(), FakeUsage(30, 8)),
        ]
    )
    model = LiveModel(model="gpt-test", client=client)

    for _ in range(3):
        model.decide(context_with())

    usage = model.usage_snapshot()
    assert usage is not None
    assert usage.model == "gpt-test"
    assert (usage.inputTokens, usage.outputTokens, usage.calls) == (60, 15, 3)
    # payload 的字段名会进 wire，TS 侧 eval 逐字读这几个 key（防漂移的锚）。
    assert set(usage.model_dump()) == {"model", "inputTokens", "outputTokens", "calls"}


def test_negative_or_non_int_tokens_count_as_zero():
    class WeirdUsage:
        input_tokens = -5
        output_tokens = "many"

    client = FakeClient([FakeResponse(tool_call_json(), WeirdUsage())])
    model = LiveModel(model="gpt-test", client=client)

    model.decide(context_with())

    usage = model.usage_snapshot()
    assert usage is not None
    assert (usage.inputTokens, usage.outputTokens) == (0, 0)


def test_empty_output_is_a_model_call_failure():
    model = LiveModel(model="gpt-test", client=FakeClient([FakeResponse("   ")]))

    with pytest.raises(ModelCallFailed) as e:
        model.decide(context_with())

    assert "output_text" in e.value.reason


def test_non_json_output_is_a_model_call_failure():
    model = LiveModel(model="gpt-test", client=FakeClient([FakeResponse("我觉得这个任务……")]))

    with pytest.raises(ModelCallFailed) as e:
        model.decide(context_with())

    assert "不是合法 JSON" in e.value.reason


def test_json_that_violates_the_decision_contract_is_a_model_call_failure():
    # 形状错（缺 callId）要在适配器层拦下，不能让半个决策流进 engine。
    bad = json.dumps({"kind": "tool_call", "capability": "filesystem.list"})
    model = LiveModel(model="gpt-test", client=FakeClient([FakeResponse(bad)]))

    with pytest.raises(ModelCallFailed) as e:
        model.decide(context_with())

    assert "ModelDecision" in e.value.reason


def test_client_errors_are_wrapped_as_model_call_failure():
    client = FakeClient([RuntimeError("502 bad gateway")])
    model = LiveModel(model="gpt-test", client=client)

    with pytest.raises(ModelCallFailed) as e:
        model.decide(context_with())

    assert "502 bad gateway" in e.value.reason


def test_a_failed_call_records_no_usage_but_later_calls_do():
    # SDK 的异常里没有用量，失败的那次只能不记账；后续成功的调用照记。
    # 全失败的任务 usage_snapshot 就是 None，engine 不为它加零用量事件。
    client = FakeClient([RuntimeError("超时"), FakeResponse(tool_call_json(), FakeUsage(4, 1))])
    model = LiveModel(model="gpt-test", client=client)

    with pytest.raises(ModelCallFailed):
        model.decide(context_with())
    model.decide(context_with())

    usage = model.usage_snapshot()
    assert usage is not None
    assert usage.calls == 1  # 只有成功的那次进了账
    assert (usage.inputTokens, usage.outputTokens) == (4, 1)


def test_model_without_a_client_builds_one_lazily(monkeypatch):
    # 不传 client 时现建 openai.OpenAI()：没有 API Key 就在这一步失败，
    # 而且必须收成 ModelCallFailed —— 构造期不碰网络，握手与 ping 不受影响。
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    model = LiveModel(model="gpt-test")

    with pytest.raises(ModelCallFailed) as e:
        model.decide(context_with())

    assert "api_key" in e.value.reason.lower() or "client" in e.value.reason


def test_live_model_env_name_is_the_documented_one():
    # DEP-012 写死了这个变量名，TS 侧 eval 的 live 入口按它开启真模型。
    assert LIVE_MODEL_ENV == "OPENAI_MODEL"


# ---- TASK-033 R4: responses.stream 与思维摘要 ----


def test_decide_with_reasoning_summary_streams_thinking_deltas():
    events = [
        FakeStreamEvent("response.reasoning_summary_text.delta", delta="思考第1步"),
        FakeStreamEvent("response.text.delta", delta="忽略正文增量"),
        FakeStreamEvent("response.reasoning_summary_text.delta", delta="；思考第2步"),
    ]
    client = FakeClient(
        [FakeResponse(tool_call_json(), FakeUsage(10, 5))],
        stream_events=events,
    )
    model = LiveModel(model="gpt-test", client=client, reasoning_summary=True)

    chunks: list[str] = []
    decision = model.decide(context_with(), on_thinking=chunks.append)

    assert isinstance(decision, ToolCallDecision)
    assert len(client.responses.stream_requests) == 1
    assert len(client.responses.requests) == 0
    stream_req = client.responses.stream_requests[0]
    assert stream_req["reasoning"] == {"summary": "auto"}
    assert stream_req["store"] is False
    assert chunks == ["思考第1步", "；思考第2步"]
    assert model.usage_snapshot() is not None
    assert model.usage_snapshot().inputTokens == 10
    assert model.usage_snapshot().outputTokens == 5


def test_decide_without_reasoning_summary_uses_create():
    client = FakeClient([FakeResponse(tool_call_json())])
    model = LiveModel(model="gpt-test", client=client, reasoning_summary=False)

    decision = model.decide(context_with())

    assert isinstance(decision, ToolCallDecision)
    assert len(client.responses.requests) == 1
    assert len(client.responses.stream_requests) == 0
    assert "reasoning" not in client.responses.requests[0]


def test_decide_stream_error_is_wrapped_as_model_call_failure():
    client = FakeClient([RuntimeError("stream 400 Bad Request")])
    model = LiveModel(model="gpt-test", client=client, reasoning_summary=True)

    with pytest.raises(ModelCallFailed) as exc:
        model.decide(context_with())

    assert "stream 400 Bad Request" in exc.value.reason


def test_decide_env_var_enables_reasoning_summary(monkeypatch):
    monkeypatch.setenv("OPENAI_REASONING_SUMMARY", "1")
    client = FakeClient([FakeResponse(tool_call_json())])
    model = LiveModel(model="gpt-test", client=client)

    model.decide(context_with())

    assert len(client.responses.stream_requests) == 1
    assert client.responses.stream_requests[0]["reasoning"] == {"summary": "auto"}


def test_compose_instructions_returns_base_when_profile_is_none():
    assert compose_instructions(INSTRUCTIONS, None) == INSTRUCTIONS


def test_compose_instructions_returns_base_when_persona_is_empty_or_whitespace():
    assert (
        compose_instructions(INSTRUCTIONS, ProfileDto(name="助手", persona=""))
        == INSTRUCTIONS
    )
    assert (
        compose_instructions(
            INSTRUCTIONS, ProfileDto(name="助手", persona="   \n\t  ")
        )
        == INSTRUCTIONS
    )


def test_compose_instructions_appends_persona_and_declares_hard_rules_priority():
    profile = ProfileDto(
        name="专业助理",
        persona="保持专业严谨、多用列表回答",
        reasoningSummary=False,
    )
    result = compose_instructions("base instructions", profile)

    assert result.startswith("base instructions")
    assert "保持专业严谨、多用列表回答" in result
    assert "专业助理" in result
    assert "角色设定" in result
    assert "硬要求" in result or "执行规则" in result
    assert "优先于" in result
    assert "能力白名单" in result
    assert "页码可溯源" in result
    assert "不编造" in result


def test_decide_uses_composed_instructions_when_profile_present():
    profile = ProfileDto(name="小助手", persona="友好热情、简明扼要")
    ctx = context_with()
    ctx.profile = profile
    client = FakeClient([FakeResponse(tool_call_json())])
    model = LiveModel(model="gpt-test", client=client)

    model.decide(ctx)

    request = client.responses.requests[0]
    expected_instructions = compose_instructions(INSTRUCTIONS, profile)
    assert request["instructions"] == expected_instructions
    assert "友好热情、简明扼要" in request["instructions"]


def test_decide_profile_reasoning_summary_overrides_instance_config():
    # 实例默认为 False，但 profile 显式开启 reasoningSummary
    profile_with_stream = ProfileDto(
        name="测试", persona="", reasoningSummary=True
    )
    ctx = context_with()
    ctx.profile = profile_with_stream
    client = FakeClient([FakeResponse(tool_call_json())])
    model = LiveModel(model="gpt-test", client=client, reasoning_summary=False)

    model.decide(ctx)
    assert len(client.responses.stream_requests) == 1
    assert len(client.responses.requests) == 0

    # 实例默认为 True，但 profile 显式关闭 reasoningSummary
    profile_without_stream = ProfileDto(
        name="测试", persona="", reasoningSummary=False
    )
    ctx2 = context_with()
    ctx2.profile = profile_without_stream
    client2 = FakeClient([FakeResponse(tool_call_json())])
    model2 = LiveModel(model="gpt-test", client=client2, reasoning_summary=True)

    model2.decide(ctx2)
    assert len(client2.responses.requests) == 1
    assert len(client2.responses.stream_requests) == 0