"""LiveModel 的行为测试（TASK-027 / Chat Completions 重构）。

真 client 一构造就要 API Key、一调用就出网，这两件事都不该进单元测试，
所以全部用假 client：这里钉的是适配器的**翻译层**——ModelContext 怎么变成
Chat Completions 的 messages 与 tools、模型的返回怎么变回 ModelDecision、
用量怎么记账、失败怎么收场。
真实网络行为不在本文件的覆盖范围（CON-006：CI 不得依赖真实模型）。
"""

from __future__ import annotations

import json
from typing import Any, get_args

import pytest

from personal_agent.live_model import (
    DECISION_SCHEMA,
    FINISH_TASK_SCHEMA,
    FINISH_TASK_TOOL_NAME,
    INSTRUCTIONS,
    LIVE_MODEL_ENV,
    TOOL_SCHEMAS,
    TOOL_SPECS,
    LiveModel,
    build_tools,
    compose_instructions,
    render_input,
    render_messages,
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
    def __init__(
        self,
        input_tokens=0,
        output_tokens=0,
        prompt_tokens=None,
        completion_tokens=None,
    ):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.prompt_tokens = prompt_tokens if prompt_tokens is not None else input_tokens
        self.completion_tokens = completion_tokens if completion_tokens is not None else output_tokens


class FakeFunction:
    def __init__(self, name: str, arguments: str):
        self.name = name
        self.arguments = arguments


class FakeToolCall:
    def __init__(self, id: str, name: str, arguments: str):
        self.id = id
        self.type = "function"
        self.function = FakeFunction(name, arguments)


class FakeMessage:
    def __init__(self, content: str | None = None, tool_calls: list[Any] | None = None):
        self.content = content
        self.tool_calls = tool_calls or []


class FakeChoice:
    def __init__(self, message: FakeMessage):
        self.message = message


class FakeChatCompletion:
    def __init__(self, message: FakeMessage, usage: Any = None):
        self.choices = [FakeChoice(message)]
        self.usage = usage


class FakeResponse:
    def __init__(self, text: str, usage: Any = None):
        self.output_text = text
        self.usage = usage


def _adapt_to_chat_completion(item: Any) -> Any:
    if isinstance(item, FakeChatCompletion):
        return item
    if not isinstance(item, FakeResponse):
        return item
    text = item.output_text
    if not isinstance(text, str) or not text.strip():
        return FakeChatCompletion(FakeMessage(content=""), item.usage)
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return FakeChatCompletion(FakeMessage(content=text), item.usage)
    if isinstance(data, dict):
        kind = data.get("kind")
        if kind == "tool_call":
            tc = FakeToolCall(
                id=data.get("callId", "call-1"),
                name=data.get("capability", "filesystem.list"),
                arguments=json.dumps(data.get("arguments", {})),
            )
            return FakeChatCompletion(FakeMessage(tool_calls=[tc]), item.usage)
        elif kind == "summary":
            tc = FakeToolCall(
                id="call-finish",
                name=FINISH_TASK_TOOL_NAME,
                arguments=json.dumps(
                    {
                        "reply": data.get("reply", ""),
                        "facts": data.get("facts", []),
                    }
                ),
            )
            return FakeChatCompletion(FakeMessage(tool_calls=[tc]), item.usage)
        elif kind == "step_complete":
            tc = FakeToolCall(
                id="call-step",
                name="step_complete",
                arguments=json.dumps({"result": data.get("result", "")}),
            )
            return FakeChatCompletion(FakeMessage(tool_calls=[tc]), item.usage)
        elif kind == "replan":
            tc = FakeToolCall(
                id="call-replan",
                name="replan",
                arguments=json.dumps({"reason": data.get("reason", "")}),
            )
            return FakeChatCompletion(FakeMessage(tool_calls=[tc]), item.usage)
    return FakeChatCompletion(FakeMessage(content=text), item.usage)


class FakeStreamEvent:
    def __init__(self, type: str, delta: str = "") -> None:
        self.type = type
        self.delta = delta
        self.reasoning_content = delta


class FakeStream:
    def __init__(self, events: list[Any], final_response: Any) -> None:
        self._events = events
        self._final_response = _adapt_to_chat_completion(final_response)

    def __iter__(self):
        return iter(self._events)

    def get_final_response(self) -> Any:
        return self._final_response


class FakeStreamManager:
    def __init__(self, events: list[Any], final_response: Any) -> None:
        self._events = events
        self._final_response = _adapt_to_chat_completion(final_response)

    def __enter__(self) -> FakeStream:
        return FakeStream(self._events, self._final_response)

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        pass


class FakeChatCompletions:
    def __init__(self, items: list[Any], stream_events: list[Any] | None = None):
        self._items = list(items)
        self.requests: list[dict[str, Any]] = []
        self.stream_requests: list[dict[str, Any]] = []
        self._stream_events = list(stream_events or [])

    def create(self, **kwargs: Any) -> Any:
        if kwargs.get("stream"):
            self.stream_requests.append(kwargs)
        else:
            self.requests.append(kwargs)
        item = self._items.pop(0)
        if isinstance(item, Exception):
            raise item
        adapted = _adapt_to_chat_completion(item)
        if kwargs.get("stream"):
            return FakeStreamManager(self._stream_events, adapted)
        return adapted


class FakeChat:
    def __init__(self, items: list[Any], stream_events: list[Any] | None = None):
        self.completions = FakeChatCompletions(items, stream_events)


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
        self.chat = FakeChat(items, stream_events)
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
    assert set(TOOL_SPECS) <= set(get_args(CapabilityId))
    assert set(TOOL_SCHEMAS) <= set(get_args(CapabilityId))


def test_decision_schema_is_derived_from_the_contract():
    assert DECISION_SCHEMA["discriminator"]["propertyName"] == "kind"
    assert set(DECISION_SCHEMA["discriminator"]["mapping"]) == {
        "tool_call",
        "summary",
        "step_complete",
        "replan",
    }


def test_build_tools_filters_by_visible_and_adds_finish_task():
    tools = build_tools(["filesystem.list"])
    names = [t["function"]["name"] for t in tools]
    assert names == ["filesystem.list", FINISH_TASK_TOOL_NAME]
    assert tools[1] == FINISH_TASK_SCHEMA


def test_render_messages_full_structure():
    ctx = context_with(
        observations=[
            Observation(
                callId="call-1",
                capability="filesystem.list",
                ok=True,
                payload={"entries": [{"name": "a.pdf"}]},
                arguments={"rootId": "downloads"},
            ),
            Observation(
                callId="call-2",
                capability="document.extract_pdf",
                ok=False,
                payload={"code": "PDF_UNREADABLE", "reason": "损坏"},
                arguments={"path": "/docs/a.pdf"},
            ),
        ],
        plan=[
            PlanStepDto(description="列出目录", capability="filesystem.list"),
            PlanStepDto(description="总结汇报"),
        ],
        history=[Turn(role="user", text="请帮我整理文件")],
    )
    messages = render_messages(ctx)
    assert len(messages) == 7
    # 1. system
    assert messages[0]["role"] == "system"
    assert INSTRUCTIONS in messages[0]["content"]
    # 2. history
    assert messages[1] == {"role": "user", "content": "请帮我整理文件"}
    # 3. current task goal & plan
    assert messages[2]["role"] == "user"
    assert "整理 Downloads 里的 PDF" in messages[2]["content"]
    assert "1. 列出目录（filesystem.list）" in messages[2]["content"]
    assert "2. 总结汇报" in messages[2]["content"]
    # 4. assistant call-1
    assert messages[3]["role"] == "assistant"
    assert messages[3]["tool_calls"][0]["id"] == "call-1"
    assert messages[3]["tool_calls"][0]["function"]["name"] == "filesystem.list"
    assert json.loads(messages[3]["tool_calls"][0]["function"]["arguments"]) == {"rootId": "downloads"}
    # 5. tool result 1
    assert messages[4]["role"] == "tool"
    assert messages[4]["tool_call_id"] == "call-1"
    assert "a.pdf" in messages[4]["content"]
    # 6. assistant call-2
    assert messages[5]["role"] == "assistant"
    assert messages[5]["tool_calls"][0]["id"] == "call-2"


def test_render_messages_empty_history_and_plan():
    ctx = context_with()
    messages = render_messages(ctx)
    assert len(messages) == 2
    assert messages[0]["role"] == "system"
    assert messages[1]["role"] == "user"
    assert "整理 Downloads 里的 PDF" in messages[1]["content"]
    assert "（空）" in messages[1]["content"]


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
    assert "ok=False" in rendered and "PDF_UNREADABLE" in rendered
    assert "坏了" in rendered


def test_instructions_no_longer_hardcode_the_golden_path():
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
    request = client.chat.completions.requests[0]
    assert request["model"] == "gpt-test"
    assert any(t["function"]["name"] == "filesystem.list" for t in request["tools"])
    assert any(t["function"]["name"] == FINISH_TASK_TOOL_NAME for t in request["tools"])


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
    client = FakeClient([FakeResponse(tool_call_json())])
    model = LiveModel(model="gpt-test", client=client)

    model.decide(context_with())

    usage = model.usage_snapshot()
    assert usage is not None
    assert (usage.inputTokens, usage.outputTokens, usage.calls) == (0, 0, 1)


def test_usage_snapshot_is_none_before_any_call():
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

    assert "未输出任何文本内容" in e.value.reason or "没有给出" in e.value.reason


def test_non_json_output_as_plain_text_summary_fallback():
    # 纯文本回复作为自然语言回答兜底成功
    model = LiveModel(model="gpt-test", client=FakeClient([FakeResponse("任务已经全部完成。")]))

    decision = model.decide(context_with())
    assert isinstance(decision, SummaryDecision)
    assert decision.reply == "任务已经全部完成。"
    assert decision.facts == []


def test_json_that_violates_the_decision_contract_is_a_model_call_failure():
    tc = FakeToolCall(id="c-1", name="filesystem.list", arguments="{not_json")
    resp = FakeChatCompletion(FakeMessage(tool_calls=[tc]))
    model = LiveModel(model="gpt-test", client=FakeClient([resp]))

    with pytest.raises(ModelCallFailed) as e:
        model.decide(context_with())

    assert "不是合法 JSON" in e.value.reason


def test_client_errors_are_wrapped_as_model_call_failure():
    client = FakeClient([RuntimeError("502 bad gateway")])
    model = LiveModel(model="gpt-test", client=client)

    with pytest.raises(ModelCallFailed) as e:
        model.decide(context_with())

    assert "502 bad gateway" in e.value.reason


def test_a_failed_call_records_no_usage_but_later_calls_do():
    client = FakeClient([RuntimeError("超时"), FakeResponse(tool_call_json(), FakeUsage(4, 1))])
    model = LiveModel(model="gpt-test", client=client)

    with pytest.raises(ModelCallFailed):
        model.decide(context_with())
    model.decide(context_with())

    usage = model.usage_snapshot()
    assert usage is not None
    assert usage.calls == 1
    assert (usage.inputTokens, usage.outputTokens) == (4, 1)


def test_model_without_a_client_builds_one_lazily(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    model = LiveModel(model="gpt-test")

    with pytest.raises(ModelCallFailed) as e:
        model.decide(context_with())

    assert "api_key" in e.value.reason.lower() or "client" in e.value.reason


def test_live_model_env_name_is_the_documented_one():
    assert LIVE_MODEL_ENV == "OPENAI_MODEL"


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
    assert len(client.chat.completions.stream_requests) == 1
    assert len(client.chat.completions.requests) == 0
    assert chunks == ["思考第1步", "；思考第2步"]
    assert model.usage_snapshot() is not None
    assert model.usage_snapshot().inputTokens == 10
    assert model.usage_snapshot().outputTokens == 5


def test_decide_without_reasoning_summary_uses_create():
    client = FakeClient([FakeResponse(tool_call_json())])
    model = LiveModel(model="gpt-test", client=client, reasoning_summary=False)

    decision = model.decide(context_with())

    assert isinstance(decision, ToolCallDecision)
    assert len(client.chat.completions.requests) == 1
    assert len(client.chat.completions.stream_requests) == 0


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

    assert len(client.chat.completions.stream_requests) == 1


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

    request = client.chat.completions.requests[0]
    expected_instructions = compose_instructions(INSTRUCTIONS, profile)
    assert request["messages"][0]["content"] == expected_instructions
    assert "友好热情、简明扼要" in request["messages"][0]["content"]


def test_decide_profile_reasoning_summary_overrides_instance_config():
    profile_with_stream = ProfileDto(
        name="测试", persona="", reasoningSummary=True
    )
    ctx = context_with()
    ctx.profile = profile_with_stream
    client = FakeClient([FakeResponse(tool_call_json())])
    model = LiveModel(model="gpt-test", client=client, reasoning_summary=False)

    model.decide(ctx)
    assert len(client.chat.completions.stream_requests) == 1
    assert len(client.chat.completions.requests) == 0

    profile_without_stream = ProfileDto(
        name="测试", persona="", reasoningSummary=False
    )
    ctx2 = context_with()
    ctx2.profile = profile_without_stream
    client2 = FakeClient([FakeResponse(tool_call_json())])
    model2 = LiveModel(model="gpt-test", client=client2, reasoning_summary=True)

    model2.decide(ctx2)
    assert len(client2.chat.completions.requests) == 1
    assert len(client2.chat.completions.stream_requests) == 0