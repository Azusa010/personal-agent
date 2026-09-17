"""live_planner.py：清洗规则、提示词渲染与失败路径。"""

import json

import pytest

from personal_agent.live_planner import (
    PLAN_OUTPUT_ADAPTER,
    PLANNER_INSTRUCTIONS,
    LivePlanner,
    clean_plan,
    render_plan_input,
)
from personal_agent.model_gateway import ModelCallFailed
from personal_agent.protocol.models import Turn

VISIBLE = [
    "filesystem.list",
    "document.extract_pdf",
    "filesystem.create_dir",
    "filesystem.move",
    "scheduler.create",
]


class FakeResponse:
    def __init__(self, text: str):
        self.output_text = text


class FakeResponses:
    def __init__(self, items):
        self._items = list(items)
        self.requests = []

    def create(self, **kwargs):
        self.requests.append(kwargs)
        item = self._items.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeClient:
    def __init__(self, items):
        self.responses = FakeResponses(items)


def plan_json(steps):
    return json.dumps({"steps": steps})


def full_plan_json():
    return plan_json(
        [
            {"description": "列出 Downloads 下的 PDF", "capability": "filesystem.list"},
            {
                "description": "提取目标 PDF 的每页文本",
                "capability": "document.extract_pdf",
            },
            {"description": "基于页面内容生成带页码引用的摘要"},
        ]
    )


# ---- clean_plan：清洗规则 ----

def test_clean_plan_keeps_the_model_order_and_drops_no_step():
    steps = clean_plan(
        [
            {"description": "先列文件", "capability": "filesystem.list"},
            {"description": "再回答"},
        ],
        VISIBLE,
    )
    assert [s.capability for s in steps] == ["filesystem.list", None]
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
    rendered = render_plan_input("整理 Downloads 里的 PDF", ["filesystem.list"])
    assert "整理 Downloads 里的 PDF" in rendered
    assert "filesystem.list" in rendered
    # Scope 外的能力不下发：notification.send 在 TOOL_SPECS 里，但不该出现在这里。
    assert "notification.send" not in rendered


def test_render_plan_input_renders_the_history_for_coreference():
    # 「把它移回 Downloads」里的「它」只能从上一轮解析：历史要以可读的
    # 角色标记进入规划请求。
    rendered = render_plan_input(
        "把它移回 Downloads",
        ["filesystem.list", "filesystem.move"],
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
        "filesystem.list",
        "document.extract_pdf",
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