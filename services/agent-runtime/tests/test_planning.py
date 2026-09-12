"""planning.make_plan 的行为测试。

计划是 Main 侧 ActionAlignment 的比对基准，所以这里钉死的不只是「能返回三步」，
而是顺序、capability、description 逐字，以及确定性——E2E 连跑 20 轮要求每轮计划相同。
"""

import pytest
from pydantic import ValidationError

from personal_agent.planning import PlanError, PlanStep, make_plan

GOAL = "整理 Downloads 里的 PDF，给出带页码引用的摘要"
VISIBLE = ["filesystem.list", "document.extract_pdf"]

# 与已删掉的 TS 侧 plan-template.ts::PHASE1_PLAN_STEPS 逐字一致。
# 搬迁最容易出的错就是中文描述被顺手改写，UI 上看不出来，但计划就不再是同一份了。
EXPECTED_DESCRIPTIONS = [
    "列出 Downloads 下的 PDF",
    "提取目标 PDF 的每页文本",
    "基于页面内容生成带页码引用的摘要",
]
EXPECTED_CAPABILITIES = ["filesystem.list", "document.extract_pdf", None]


def test_make_plan_returns_three_steps_in_execution_order() -> None:
    steps = make_plan(GOAL, VISIBLE)
    assert len(steps) == 3
    assert all(isinstance(s, PlanStep) for s in steps)


def test_make_plan_capabilities_are_the_read_only_golden_path() -> None:
    steps = make_plan(GOAL, VISIBLE)
    assert [s.capability for s in steps] == EXPECTED_CAPABILITIES


def test_make_plan_descriptions_match_the_old_ts_template() -> None:
    steps = make_plan(GOAL, VISIBLE)
    assert [s.description for s in steps] == EXPECTED_DESCRIPTIONS


def test_make_plan_summary_step_carries_no_capability() -> None:
    """第三步由模型自己产出，不经工具，所以没有 capability。"""
    assert make_plan(GOAL, VISIBLE)[2].capability is None


def test_make_plan_is_deterministic_across_calls() -> None:
    first = make_plan(GOAL, VISIBLE)
    second = make_plan(GOAL, VISIBLE)
    assert [s.model_dump() for s in first] == [s.model_dump() for s in second]


def test_make_plan_returns_a_fresh_list_each_time() -> None:
    """改坏返回值不能污染下一次调用：20 轮里第 1 轮改了就全脏。"""
    steps = make_plan(GOAL, VISIBLE)
    steps.clear()
    assert len(make_plan(GOAL, VISIBLE)) == 3


def test_make_plan_raises_when_filesystem_list_is_not_visible() -> None:
    with pytest.raises(PlanError, match="filesystem.list"):
        make_plan(GOAL, ["document.extract_pdf"])


def test_make_plan_raises_when_extract_pdf_is_not_visible() -> None:
    with pytest.raises(PlanError, match="document.extract_pdf"):
        make_plan(GOAL, ["filesystem.list"])


def test_make_plan_raises_when_nothing_is_visible() -> None:
    with pytest.raises(PlanError):
        make_plan(GOAL, [])


def test_make_plan_ignores_capabilities_it_does_not_need() -> None:
    """Scope 放宽到 WRITE 也不该改变计划：Phase 2 的链路仍然是只读三步。"""
    wider = [*VISIBLE, "filesystem.create_dir", "filesystem.move"]
    assert [s.capability for s in make_plan(GOAL, wider)] == EXPECTED_CAPABILITIES


def test_make_plan_goal_does_not_change_the_plan_yet() -> None:
    """Phase 2 的计划是固定的，goal 只是带着走。这条测试是「将来要做动态规划」的
    绊线：真做了动态规划，它会红，那时就该改这条而不是删掉它。"""
    other = make_plan("把去年的发票单独放一个文件夹", VISIBLE)
    assert [s.model_dump() for s in other] == [
        s.model_dump() for s in make_plan(GOAL, VISIBLE)
    ]


def test_plan_step_dumps_without_a_null_capability() -> None:
    """跨语言陷阱：zod 的 optional 收 undefined 但不收 null。
    Response.model_dump(exclude_none=True) 会递归剔掉 None，所以线上形状没有这个键。
    这里钉的是「剔掉之后正是 wire 契约要的形状」。"""
    dumped = PlanStep(description=EXPECTED_DESCRIPTIONS[2]).model_dump(exclude_none=True)
    assert dumped == {"description": EXPECTED_DESCRIPTIONS[2]}
    assert "capability" not in dumped


def test_plan_step_keeps_capability_when_present() -> None:
    dumped = PlanStep(description="x", capability="filesystem.list").model_dump(
        exclude_none=True
    )
    assert dumped == {"description": "x", "capability": "filesystem.list"}


def test_plan_step_rejects_a_capability_outside_the_enum() -> None:
    """计划里写一个不存在的能力名必须在契约层就拒，不能等到执行时才发现。"""
    with pytest.raises(ValidationError):
        PlanStep(description="x", capability="filesystem.delete")


def test_plan_step_rejects_an_empty_description() -> None:
    with pytest.raises(ValidationError):
        PlanStep(description="")


def test_plan_error_is_a_value_error() -> None:
    """调用方（handle_make_plan）按 ValueError 兜底转成错误信封。"""
    assert issubclass(PlanError, ValueError)
