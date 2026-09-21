"""live_planner.py：清洗规则、提示词渲染与失败路径。"""

import json
from typing import Any

import pytest

from personal_agent.live_model import compose_instructions
from personal_agent.live_planner import (
    PLAN_OUTPUT_ADAPTER,
    PLANNER_INSTRUCTIONS,
    LivePlanner,
    clean_plan,
    render_plan_input,
)
from personal_agent.model_gateway import ModelCallFailed
from personal_agent.protocol.models import ProfileDto, Turn

VISIBLE = [
    "filesystem_list",
    "document_extract_pdf",
    "filesystem_create_dir",
    "filesystem_move",
    "scheduler_create",
]


class FakeResponse:
    def __init__(self, text: str):
        self.output_text = text


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


def plan_json(steps):
    return json.dumps({"steps": steps})


def full_plan_json():
    return plan_json(
        [
            {"description": "列出 Downloads 下的 PDF", "capability": "filesystem_list"},
            {
                "description": "提取目标 PDF 的每页文本",
                "capability": "document_extract_pdf",
            },
            {"description": "基于页面内容生成带页码引用的摘要"},
        ]
    )


# ---- clean_plan：清洗规则 ----

def test_clean_plan_keeps_the_model_order_and_drops_no_step():
    steps = clean_plan(
        [
            {"description": "先列文件", "capability": "filesystem_list"},
            {"description": "再回答"},
        ],
        VISIBLE,
    )
    assert [s.capability for s in steps] == ["filesystem_list", None]
    assert [s.description for s in steps] == ["先列文件", "再回答"]


def test_clean_plan_rejects_a_capability_outside_the_visible_list():
    with pytest.raises(ModelCallFailed) as err:
        clean_plan([{"description": "执行 shell", "capability": "shell.exec"}], VISIBLE)
    assert "shell.exec" in err.value.reason


def test_clean_plan_rejects_an_empty_plan():
    with pytest.raises(ModelCallFailed):
        clean_plan([], VISIBLE)


def test_clean_plan_treats_capability_as_optional_not_nullable_string():
    # 不需要工具的那一步省略 capability 键：缺键 → None，与线上形状一致
    # （handle_make_plan 的 exclude_none=True 会把它剔掉）。
    steps = clean_plan([{"description": "直接回答"}], VISIBLE)
    assert steps[0].capability is None


def test_a_plan_without_tools_is_valid_even_when_nothing_is_visible():
    # 零工具轮次：可见能力一个都没有时，仍然允许「直接回答」这一步的计划。
    steps = clean_plan([{"description": "直接回答用户"}], [])
    assert steps[0].capability is None


# ---- render_plan_input ----

def test_render_plan_input_lists_goal_and_only_visible_capabilities():
    rendered = render_plan_input("整理 Downloads 里的 PDF", ["filesystem_list"])
    assert "整理 Downloads 里的 PDF" in rendered
    assert "filesystem_list" in rendered
    # Scope 外的能力不下发：notification_send 在 TOOL_SPECS 里，但不该出现在这里。
    assert "notification_send" not in rendered


def test_render_plan_input_renders_the_history_for_coreference():
    # 「把它移回 Downloads」里的「它」只能从上一轮解析：历史要以可读的
    # 角色标记进入规划请求。
    rendered = render_plan_input(
        "把它移回 Downloads",
        ["filesystem_list", "filesystem_move"],
        [
            Turn(role="user", text="把最新的 PDF 整理到 Reading"),
            Turn(role="assistant", text="已整理好"),
        ],
    )

    assert "之前的对话" in rendered
    assert "[user] 把最新的 PDF 整理到 Reading" in rendered
    assert "[assistant] 已整理好" in rendered


def test_render_plan_input_omits_the_history_section_on_the_first_turn():
    # 第一轮最常见：整段省略，不给模型一个空标题。
    rendered = render_plan_input("整理 Downloads 里的 PDF", VISIBLE, [])

    assert "之前的对话" not in rendered


# ---- LivePlanner：请求形状与失败路径 ----

def test_plan_sends_the_planner_instructions_and_the_output_schema():
    client = FakeClient([FakeResponse(full_plan_json())])
    planner = LivePlanner(model="gpt-test", client=client)

    steps = planner.plan("整理 Downloads 里的 PDF", VISIBLE)

    assert [s.capability for s in steps] == [
        "filesystem_list",
        "document_extract_pdf",
        None,
    ]
    request = client.responses.requests[0]
    assert request["model"] == "gpt-test"
    assert request["instructions"] == PLANNER_INSTRUCTIONS
    assert request["text"]["format"]["schema"] == PLAN_OUTPUT_ADAPTER.json_schema()
    # strict=True 会拒掉自由对象，与执行侧同一个理由。
    assert request["text"]["format"]["strict"] is False
    assert request["store"] is False


def test_plan_sends_the_history_in_the_input():
    client = FakeClient([FakeResponse(full_plan_json())])
    planner = LivePlanner(model="gpt-test", client=client)

    planner.plan(
        "把它移回 Downloads",
        VISIBLE,
        [Turn(role="user", text="把最新的 PDF 整理到 Reading")],
    )

    request = client.responses.requests[0]
    # 历史与本轮目标同框：模型解析「它」靠的是 request["input"] 这段文本。
    assert "把最新的 PDF 整理到 Reading" in request["input"]
    assert "把它移回 Downloads" in request["input"]


def test_plan_rejects_a_plan_that_uses_an_invisible_capability():
    client = FakeClient(
        [
            FakeResponse(
                plan_json([{"description": "删掉文件", "capability": "filesystem.delete"}])
            )
        ]
    )
    with pytest.raises(ModelCallFailed):
        LivePlanner(model="gpt-test", client=client).plan("清理 Downloads", VISIBLE)


def test_empty_output_is_a_model_call_failure():
    client = FakeClient([FakeResponse("")])
    with pytest.raises(ModelCallFailed):
        LivePlanner(model="gpt-test", client=client).plan("整理 PDF", VISIBLE)


def test_non_json_output_is_a_model_call_failure():
    client = FakeClient([FakeResponse("先把文件列出来吧")])
    with pytest.raises(ModelCallFailed):
        LivePlanner(model="gpt-test", client=client).plan("整理 PDF", VISIBLE)


def test_json_that_violates_the_plan_contract_is_a_model_call_failure():
    client = FakeClient([FakeResponse(json.dumps({"steps": "不是列表"}))])
    with pytest.raises(ModelCallFailed):
        LivePlanner(model="gpt-test", client=client).plan("整理 PDF", VISIBLE)


def test_client_errors_are_wrapped_as_model_call_failure():
    client = FakeClient([RuntimeError("boom")])
    with pytest.raises(ModelCallFailed) as err:
        LivePlanner(model="gpt-test", client=client).plan("整理 PDF", VISIBLE)
    assert "boom" in err.value.reason


def test_plan_defaults_to_direct_answer_step_when_model_returns_empty_steps():
    # 容错兜底：当模型面对打招呼等无工具诉求吐出空 steps 时，自动兜底为单步直接回答
    client = FakeClient([FakeResponse(json.dumps({"steps": []}))])
    steps = LivePlanner(model="gpt-test", client=client).plan("你好", VISIBLE)
    assert len(steps) == 1
    assert steps[0].description == "直接回答用户"
    assert steps[0].capability is None


# ---- TASK-033 R4: responses.stream 与思维摘要 ----



def test_plan_with_reasoning_summary_streams_thinking_deltas():
    events = [
        FakeStreamEvent("response.reasoning_summary_text.delta", delta="规划中：先列出文件"),
        FakeStreamEvent("response.reasoning_summary_text.delta", delta="，再提取文本"),
    ]
    client = FakeClient(
        [FakeResponse(full_plan_json())],
        stream_events=events,
    )
    planner = LivePlanner(model="gpt-test", client=client, reasoning_summary=True)

    chunks: list[str] = []
    steps = planner.plan("整理 PDF", VISIBLE, on_thinking=chunks.append)

    assert len(steps) == 3
    assert len(client.responses.stream_requests) == 1
    assert len(client.responses.requests) == 0
    stream_req = client.responses.stream_requests[0]
    assert stream_req["reasoning"] == {"summary": "auto"}
    assert stream_req["store"] is False
    assert chunks == ["规划中：先列出文件", "，再提取文本"]


def test_plan_without_reasoning_summary_uses_create():
    client = FakeClient([FakeResponse(full_plan_json())])
    planner = LivePlanner(model="gpt-test", client=client, reasoning_summary=False)

    steps = planner.plan("整理 PDF", VISIBLE)

    assert len(steps) == 3
    assert len(client.responses.requests) == 1
    assert len(client.responses.stream_requests) == 0
    assert "reasoning" not in client.responses.requests[0]


def test_plan_stream_error_is_wrapped_as_model_call_failure():
    client = FakeClient([RuntimeError("stream network down")])
    planner = LivePlanner(model="gpt-test", client=client, reasoning_summary=True)

    with pytest.raises(ModelCallFailed) as exc:
        planner.plan("整理 PDF", VISIBLE)

    assert "stream network down" in exc.value.reason


def test_plan_env_var_enables_reasoning_summary(monkeypatch):
    monkeypatch.setenv("OPENAI_REASONING_SUMMARY", "true")
    client = FakeClient([FakeResponse(full_plan_json())])
    planner = LivePlanner(model="gpt-test", client=client)

    planner.plan("整理 PDF", VISIBLE)

    assert len(client.responses.stream_requests) == 1
    assert client.responses.stream_requests[0]["reasoning"] == {"summary": "auto"}


def test_plan_uses_composed_instructions_when_profile_present():
    profile = ProfileDto(name="规划师", persona="优先使用最小步骤")
    client = FakeClient([FakeResponse(full_plan_json())])
    planner = LivePlanner(model="gpt-test", client=client)

    planner.plan("整理 Downloads 里的 PDF", VISIBLE, profile=profile)

    request = client.responses.requests[0]
    assert request["instructions"] == compose_instructions(
        PLANNER_INSTRUCTIONS, profile
    )
    assert "优先使用最小步骤" in request["instructions"]


def test_plan_profile_reasoning_summary_overrides_instance_config():
    profile_stream = ProfileDto(name="规划师", persona="", reasoningSummary=True)
    client = FakeClient([FakeResponse(full_plan_json())])
    planner = LivePlanner(
        model="gpt-test", client=client, reasoning_summary=False
    )

    planner.plan("整理 Downloads 里的 PDF", VISIBLE, profile=profile_stream)
    assert len(client.responses.stream_requests) == 1
    assert len(client.responses.requests) == 0


def test_plan_without_summary_events_streams_plan_steps_fallback():
    # 模拟 DeepSeek 等非 OpenAI o1/o3 模型：无 reasoning_summary 增量
    events = [
        FakeStreamEvent("response.text.delta", delta="{}"),
    ]
    client = FakeClient(
        [FakeResponse(full_plan_json())],
        stream_events=events,
    )
    planner = LivePlanner(model="gpt-test", client=client, reasoning_summary=True)

    chunks: list[str] = []
    steps = planner.plan("整理 PDF", VISIBLE, on_thinking=chunks.append)

    assert len(steps) == 3
    assert "制定执行策略（共 3 步）：" in "".join(chunks)


