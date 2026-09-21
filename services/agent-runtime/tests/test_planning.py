"""planning.make_plan 的行为测试。

计划是 Main 侧 ActionAlignment 的比对基准，所以这里钉死的不只是「能返回几步」，
而是顺序、capability、description 逐字，以及确定性——E2E 连跑 20 轮要求每轮计划相同。

TASK-028 起计划是完整的 Golden Path：两个 READ 加三个 WRITE（建目录 / 移动 /
建提醒），摘要在最后且没有 capability。顺序即执行顺序——摘要是 engine 的终态决策，
写操作必须排在它前面，否则模型一给摘要循环就结束了。
"""

import pytest
from pydantic import ValidationError

from personal_agent.planning import PlanError, PlanStep, make_plan

GOAL = "整理 Downloads 里的 PDF，给出带页码引用的摘要"
VISIBLE = [
    "filesystem_list",
    "document_extract_pdf",
    "filesystem_create_dir",
    "filesystem_move",
    "scheduler_create",
]

EXPECTED_DESCRIPTIONS = [
    "列出 Downloads 下的 PDF",
    "提取目标 PDF 的每页文本",
    "在 Downloads 下创建 Reading 目录",
    "把选中的 PDF 移到 Reading",
    "创建一次性阅读提醒",
    "基于页面内容生成带页码引用的摘要",
]
EXPECTED_CAPABILITIES = [
    "filesystem_list",
    "document_extract_pdf",
    "filesystem_create_dir",
    "filesystem_move",
    "scheduler_create",
    None,
]

SUMMARY_STEP = EXPECTED_DESCRIPTIONS[-1]


def test_make_plan_returns_the_full_golden_path_in_execution_order() -> None:
    steps = make_plan(GOAL, VISIBLE)
    assert len(steps) == len(EXPECTED_CAPABILITIES)
    assert all(isinstance(s, PlanStep) for s in steps)


def test_make_plan_capabilities_are_read_then_write_then_summary() -> None:
    steps = make_plan(GOAL, VISIBLE)
    assert [s.capability for s in steps] == EXPECTED_CAPABILITIES


def test_make_plan_descriptions_are_stable() -> None:
    # 描述进 UI，也是 E2E 的逐字断言。搬迁或改写最容易出的错就是中文被顺手改掉，
    # 界面上看不出来，但计划就不再是同一份了。
    steps = make_plan(GOAL, VISIBLE)
    assert [s.description for s in steps] == EXPECTED_DESCRIPTIONS


def test_make_plan_summary_step_carries_no_capability() -> None:
    """最后一步由模型自己产出，不经工具，所以没有 capability。"""
    assert make_plan(GOAL, VISIBLE)[-1].capability is None


def test_write_steps_come_before_the_summary() -> None:
    """摘要一旦给出，engine 的循环就结束——写操作排在它后面等于永远不会执行。"""
    steps = make_plan(GOAL, VISIBLE)
    writes = {"filesystem_create_dir", "filesystem_move", "scheduler_create"}
    indices = [i for i, s in enumerate(steps) if s.capability in writes]

    assert indices == [2, 3, 4]
    assert steps[-1].capability is None


def test_make_plan_is_deterministic_across_calls() -> None:
    first = make_plan(GOAL, VISIBLE)
    second = make_plan(GOAL, VISIBLE)
    assert [s.model_dump() for s in first] == [s.model_dump() for s in second]


def test_make_plan_returns_a_fresh_list_each_time() -> None:
    """改坏返回值不能污染下一次调用：20 轮里第 1 轮改了就全脏。"""
    steps = make_plan(GOAL, VISIBLE)
    steps.clear()
    assert len(make_plan(GOAL, VISIBLE)) == len(EXPECTED_CAPABILITIES)


def test_make_plan_raises_when_filesystem_list_is_not_visible() -> None:
    with pytest.raises(PlanError, match="filesystem_list"):
        make_plan(GOAL, [c for c in VISIBLE if c != "filesystem_list"])


def test_make_plan_raises_when_extract_pdf_is_not_visible() -> None:
    with pytest.raises(PlanError, match="document_extract_pdf"):
        make_plan(GOAL, [c for c in VISIBLE if c != "document_extract_pdf"])


def test_make_plan_shrinks_to_a_read_only_plan_when_writes_are_not_visible() -> None:
    """只给两个 READ 时计划就是三步（list / extract / 摘要）。

    Live Eval 与只读 E2E 用的就是这种配置：它们量的是「读文档、给带页码的摘要」，
    不该被交付物闸口要求「文件已移动、Reminder 已创建」——闸口是按计划推导的，
    计划里没有 WRITE 就不会要求它们的交付物。
    """
    steps = make_plan(GOAL, ["filesystem_list", "document_extract_pdf"])

    assert [s.capability for s in steps] == ["filesystem_list", "document_extract_pdf", None]
    assert [s.description for s in steps] == [
        "列出 Downloads 下的 PDF",
        "提取目标 PDF 的每页文本",
        "基于页面内容生成带页码引用的摘要",
    ]


def test_make_plan_includes_only_the_visible_write_steps() -> None:
    """WRITE 是逐个伸缩的：可见哪个就有哪一步，顺序仍按 WRITE_STEPS。"""
    steps = make_plan(GOAL, ["filesystem_list", "document_extract_pdf", "scheduler_create"])

    assert [s.capability for s in steps] == [
        "filesystem_list",
        "document_extract_pdf",
        "scheduler_create",
        None,
    ]


def test_make_plan_keeps_the_write_order_from_the_table() -> None:
    """可见顺序被打乱也不改计划顺序：计划是执行顺序。"""
    shuffled = [
        "scheduler_create",
        "document_extract_pdf",
        "filesystem_move",
        "filesystem_create_dir",
        "filesystem_list",
    ]

    assert [s.capability for s in make_plan(GOAL, shuffled)] == EXPECTED_CAPABILITIES


def test_make_plan_raises_when_nothing_is_visible() -> None:
    with pytest.raises(PlanError):
        make_plan(GOAL, [])


def test_make_plan_ignores_capabilities_it_does_not_need() -> None:
    """可见清单里多出 notification_send（由 Reminder 到点触发，不是模型自选动作）
    不该改变计划。"""
    wider = [*VISIBLE, "notification_send"]
    assert [s.capability for s in make_plan(GOAL, wider)] == EXPECTED_CAPABILITIES


def test_make_plan_goal_does_not_change_the_plan_yet() -> None:
    """计划目前是固定的，goal 只是带着走。这条测试是「将来要做动态规划」的
    绊线：真做了动态规划，它会红，那时就该改这条而不是删掉它。"""
    other = make_plan("把去年的发票单独放一个文件夹", VISIBLE)
    assert [s.model_dump() for s in other] == [
        s.model_dump() for s in make_plan(GOAL, VISIBLE)
    ]


def test_plan_step_dumps_without_a_null_capability() -> None:
    """跨语言陷阱：zod 的 optional 收 undefined 但不收 null。
    Response.model_dump(exclude_none=True) 会递归剔掉 None，所以线上形状没有这个键。
    这里钉的是「剔掉之后正是 wire 契约要的形状」。"""
    dumped = PlanStep(description=SUMMARY_STEP).model_dump(exclude_none=True)
    assert dumped == {"description": SUMMARY_STEP}
    assert "capability" not in dumped


def test_plan_step_keeps_capability_when_present() -> None:
    dumped = PlanStep(description="x", capability="filesystem_list").model_dump(
        exclude_none=True
    )
    assert dumped == {"description": "x", "capability": "filesystem_list"}


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