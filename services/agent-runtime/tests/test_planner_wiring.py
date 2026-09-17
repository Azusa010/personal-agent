"""Planner 的选实现与错误码接线：runtime.resolve_planner_factory 与
handle_make_plan 的异常翻译。

单独一个文件而不是并进 test_runtime.py：这组用例依赖的是"选实现"这条缝，
与协议主循环（握手、run_task、事件回传）不是一回事。
"""

import json

from personal_agent.live_model import LIVE_MODEL_ENV
from personal_agent.live_planner import LivePlanner
from personal_agent.model_gateway import ModelCallFailed
from personal_agent.planner import DeterministicPlanner
from personal_agent.runtime import (
    PLAN_MODEL_FAILED,
    SCRIPT_ENV,
    RuntimeDeps,
    handle_line,
    resolve_planner_factory,
)

GOAL = "整理 Downloads 里的 PDF"


class StubChannel:
    """make_plan 一次都不该碰 host：真调到这里就说明规划串到执行侧了。"""

    def call_host(self, params):
        raise AssertionError(f"make_plan 不该调用 host（capability={params.capability}）")


def make_plan_line(req_id="20", task_id="task-001"):
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "agent.make_plan",
            "params": {"taskId": task_id, "goal": GOAL},
        }
    )


def test_planner_factory_is_deterministic_without_a_live_model(monkeypatch):
    monkeypatch.delenv(LIVE_MODEL_ENV, raising=False)

    assert isinstance(resolve_planner_factory()(), DeterministicPlanner)


def test_planner_factory_uses_the_live_model_when_configured(monkeypatch):
    monkeypatch.setenv(LIVE_MODEL_ENV, "gpt-test")

    # 只组装、不建客户端、不碰网络：配错 Key 是这次 make_plan 失败，不是进程起不来。
    assert isinstance(resolve_planner_factory()(), LivePlanner)


def test_a_script_never_takes_part_in_planning(monkeypatch):
    # 剧本描述的是 engine 的执行步骤（带游标），不是「怎么规划」。让它参与规划会先
    # 啃掉本该留给循环的决策，所以配了剧本也只用确定性计划（CON-006）。
    monkeypatch.delenv(LIVE_MODEL_ENV, raising=False)
    monkeypatch.setenv(SCRIPT_ENV, "some/script.json")

    assert isinstance(resolve_planner_factory()(), DeterministicPlanner)


def test_make_plan_reports_a_model_side_planner_failure_with_its_own_code():
    class ExplodingPlanner:
        def plan(self, goal, visibleCapabilities, history=()):
            raise ModelCallFailed("模型没给出任何步骤")

    deps = RuntimeDeps(channel=StubChannel(), planner_factory=ExplodingPlanner)

    out = handle_line(make_plan_line(), deps)

    assert out["error"]["code"] == PLAN_MODEL_FAILED
    assert "模型没给出任何步骤" in out["error"]["message"]