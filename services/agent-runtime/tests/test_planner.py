"""planner.py 的端口契约与确定性实现。"""

import pytest

from personal_agent.planner import DeterministicPlanner, Planner
from personal_agent.planning import PlanError, make_plan
from personal_agent.protocol.models import Turn

FULL = [
    "filesystem_list",
    "document_extract_pdf",
    "filesystem_create_dir",
    "filesystem_move",
    "scheduler_create",
]
READ_ONLY = ["filesystem_list", "document_extract_pdf"]


def test_deterministic_planner_outputs_make_plan_verbatim():
    # 端口是包装不是改写：接了端口之后确定性路径的输出必须与 TASK-013 以来的
    # make_plan 逐字相同，否则 20 轮 E2E 与交付物判定会一起漂。
    planner = DeterministicPlanner()
    for visible in (FULL, READ_ONLY):
        assert planner.plan("整理 Downloads 里的 PDF", visible) == make_plan(
            "整理 Downloads 里的 PDF", visible
        )


def test_deterministic_planner_is_stateless():
    planner = DeterministicPlanner()
    first = planner.plan("整理 PDF", FULL)
    second = planner.plan("整理 PDF", FULL)
    assert first == second
    # 每次都是新 list：调用方拿到手改了它，不该影响下一次。
    assert first is not second


def test_deterministic_planner_reports_missing_read_capability():
    # 缺 READ 能力时异常要透传：翻成 PLAN_NOT_BUILDABLE 是 runtime 的事，
    # 端口吞掉的话协议层只能回一个说不清原因的失败。
    with pytest.raises(PlanError):
        DeterministicPlanner().plan("整理 PDF", ["scheduler_create"])


def test_deterministic_planner_satisfies_the_port():
    assert isinstance(DeterministicPlanner(), Planner)


def test_deterministic_planner_ignores_history():
    # 历史是 LivePlanner 用来解析「它」「那个文件」的，确定性路径刻意忽略：
    # 同一个目标永远给同一份计划（CON-006），多聊几句不能让它开始变化。
    planner = DeterministicPlanner()
    no_history = planner.plan("整理 PDF", FULL)
    with_history = planner.plan(
        "整理 PDF", FULL, [Turn(role="user", text="上一轮说过的话")]
    )

    assert no_history == with_history
