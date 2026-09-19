"""PlanAndExecute 动态 Re-planning 单元测试。

覆盖场景：
1. 正常 Re-plan 链路：步骤 1 遇到 ReplanDecision，Planner 给出新剩余步骤，成功替换计划并继续执行至 completed；
2. 事件流验证：replan_requested 与 replan_completed 正确发射并进入事件列表；
3. 防死循环熔断：连续 Re-plan 超过上限（2 次）时安全退出为 failed；
4. 缺失 Planner 边界：未配置 Planner 时触发 replan 正确收场为 failed。
"""

from personal_agent.engine import Budget
from personal_agent.model_gateway import (
    ReplanDecision,
    StepCompleteDecision,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.planning import PlanStep
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
    PlanStepDto,
    RunTaskCompleted,
    RunTaskFailed,
)
from personal_agent.react_loop import (
    EVENT_REPLAN_COMPLETED,
    EVENT_REPLAN_REQUESTED,
)
from personal_agent.scripted_model import ScriptedModel
from personal_agent.strategy import PlanAndExecuteStrategy

VISIBLE = ["filesystem.list", "document.extract_pdf"]


class FakeChannel:
    def __init__(self, results):
        self._results = list(results)
        self.calls = []

    def call_host(self, params: HostExecuteToolParams):
        self.calls.append(params)
        if not self._results:
            raise AssertionError("FakeChannel 预设结果已用尽")
        item = self._results.pop(0)
        if isinstance(item, Exception):
            raise item
        return HostExecuteToolResult.model_validate(item)


class FakePlanner:
    def __init__(self, plans):
        self._plans = list(plans)
        self.calls = []

    def plan(self, goal, visibleCapabilities, history=(), on_thinking=None, profile=None):
        self.calls.append({"goal": goal, "capabilities": visibleCapabilities})
        if not self._plans:
            raise AssertionError("FakePlanner 预设计划已用尽")
        return self._plans.pop(0)


def list_result():
    return {
        "ok": True,
        "entries": [
            {
                "name": "report.pdf",
                "absolutePath": "D:/downloads/report.pdf",
                "modifiedAt": "2026-09-01T00:00:00Z",
                "sizeBytes": 1024,
            }
        ],
    }


def test_replan_flow_updates_plan_and_completes():
    """场景：执行步骤 1 时模型发现需要重拟，Planner 返回新步骤，最终执行完毕。"""
    strategy = PlanAndExecuteStrategy()
    initial_plan = [
        PlanStepDto(description="查找原始文件", capability="filesystem.list"),
        PlanStepDto(description="原计划第二步：直接总结"),
    ]

    # 模型决策序列：
    # 步骤 1：先调 list，发现不对，发出 ReplanDecision
    # 重拟后的新步骤 1：调 list，返回 step_complete
    # 重拟后的新步骤 2：直接总结
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem.list",
            arguments={"rootId": "downloads"},
        ),
        ReplanDecision(
            kind="replan",
            reason="目标文件已被压缩，需要先解压再提取",
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="c-2",
            capability="filesystem.list",
            arguments={"rootId": "downloads"},
        ),
        StepCompleteDecision(
            kind="step_complete",
            result="已定位解压后的 report.pdf",
        ),
        SummaryDecision(
            kind="summary",
            reply="已完成重新规划后的任务处理",
            facts=[],
        ),
    ]
    model = ScriptedModel(decisions)
    channel = FakeChannel([list_result(), list_result()])

    # Planner 给出的新剩余步骤
    new_plan_steps = [
        PlanStep(description="重新查找解压文件", capability="filesystem.list"),
        PlanStep(description="给出总结报告"),
    ]
    planner = FakePlanner([new_plan_steps])

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="处理报告",
        visible_capabilities=VISIBLE,
        plan=initial_plan,
        history=[],
        profile=None,
        budget=Budget(maxSteps=10, maxToolCalls=5),
        stream=None,
        planner=planner,
    )

    assert isinstance(result, RunTaskCompleted)
    assert result.status == "completed"
    assert result.reply == "已完成重新规划后的任务处理"

    # 验证事件流中包含 replan_requested 与 replan_completed
    event_types = [e.type for e in result.events]
    assert EVENT_REPLAN_REQUESTED in event_types
    assert EVENT_REPLAN_COMPLETED in event_types

    # 验证 replan_completed 的 payload
    replan_event = next(e for e in result.events if e.type == EVENT_REPLAN_COMPLETED)
    assert replan_event.payload["version"] == 2
    assert replan_event.payload["reason"] == "目标文件已被压缩，需要先解压再提取"


def test_replan_hits_max_limit_fails_gracefully():
    """场景：模型持续陷入 Replan，达到最大次数（2次）后熔断失败。"""
    strategy = PlanAndExecuteStrategy()
    plan = [PlanStepDto(description="步骤 1")]

    # 每次都发出 replan
    decisions = [
        ReplanDecision(kind="replan", reason="第一次重拟"),
        ReplanDecision(kind="replan", reason="第二次重拟"),
        ReplanDecision(kind="replan", reason="第三次重拟（超标）"),
    ]
    model = ScriptedModel(decisions)
    channel = FakeChannel([])

    planner = FakePlanner([
        [PlanStep(description="重拟步 1")],
        [PlanStep(description="重拟步 2")],
    ])

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="任务",
        visible_capabilities=VISIBLE,
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(),
        stream=None,
        planner=planner,
    )

    assert isinstance(result, RunTaskFailed)
    assert result.status == "failed"
    assert "最大重规划次数" in result.reason


def test_replan_without_planner_fails():
    """场景：模型请求 Replan 但 strategy 未注入 planner，优雅收场为 failed。"""
    strategy = PlanAndExecuteStrategy()
    plan = [PlanStepDto(description="步骤 1")]

    decisions = [ReplanDecision(kind="replan", reason="需要重拟")]
    model = ScriptedModel(decisions)
    channel = FakeChannel([])

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="任务",
        visible_capabilities=VISIBLE,
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(),
        stream=None,
        planner=None,
    )

    assert isinstance(result, RunTaskFailed)
    assert result.status == "failed"
    assert "未提供 Planner" in result.reason


def test_replan_triggered_by_permission_denial_feedback():
    """场景：用户在写操作弹窗中拒绝并给出理由（如改存到 temp），模型识别后触发 replan，生成符合要求的新计划。"""
    strategy = PlanAndExecuteStrategy()
    initial_plan = [
        PlanStepDto(description="创建归档目录", capability="filesystem.create_dir"),
        PlanStepDto(description="移动文件到归档目录", capability="filesystem.move"),
    ]

    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem.create_dir",
            arguments={"path": "D:/downloads/archive"},
        ),
        ReplanDecision(
            kind="replan",
            reason="用户拒绝创建 archive 目录，指示改存到 temp 目录",
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="c-2",
            capability="filesystem.create_dir",
            arguments={"path": "D:/downloads/temp"},
        ),
        StepCompleteDecision(
            kind="step_complete",
            result="已创建 temp 目录",
        ),
        SummaryDecision(
            kind="summary",
            reply="已按用户要求改存到 temp 目录并完成处理",
            facts=[],
        ),
    ]
    model = ScriptedModel(decisions)
    channel = FakeChannel([
        {
            "ok": False,
            "code": "PERMISSION_DENIED",
            "reason": "用户拒绝了 filesystem.create_dir：不要创建 archive，请改存到 temp",
        },
        {"ok": True},
    ])

    new_plan_steps = [
        PlanStep(description="创建临时目录", capability="filesystem.create_dir"),
        PlanStep(description="完成任务总结"),
    ]
    planner = FakePlanner([new_plan_steps])

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="归档报告文件",
        visible_capabilities=["filesystem.create_dir", "filesystem.move"],
        plan=initial_plan,
        history=(),
        profile=None,
        budget=Budget(maxSteps=10, maxToolCalls=10),
        stream=None,
        planner=planner,
    )

    assert isinstance(result, RunTaskCompleted)
    assert result.reply == "已按用户要求改存到 temp 目录并完成处理"
    assert "用户拒绝创建 archive 目录" in planner.calls[0]["goal"]

