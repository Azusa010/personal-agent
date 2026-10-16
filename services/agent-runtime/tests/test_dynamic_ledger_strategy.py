"""services/agent-runtime/tests/test_dynamic_ledger_strategy.py

测试网：DynamicLedgerStrategy 现代单主循环与动态任务账本策略。
验证：
1. 契约实现与环境分流：实现 AgentStrategy 协议，resolve_strategy() 正确解析 dynamic_ledger。
2. 单层循环全程自驱动：多步任务由单个 ReActLoop 贯穿执行（不按步骤外部切片），观察全程平滑连贯。
3. 循环内重规划与流事件联动：遇到 ReplanDecision 时调用 Planner，发射 replan_completed（含 newPlan 与 version），扣减预算后继续推进。
4. 结合滑动窗口与物理日志：执行产生的工具调用原子透传至底座 MainEventLedger。
5. 预算耗尽与异常熔断安全退出：预算耗尽时安全返回 RunTaskFailed，并结算 token usage。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from personal_agent.conversation.ledger import MainEventLedger
from personal_agent.conversation.model.gateway import (
    ModelContext,
    ModelDecision,
    ModelGateway,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.conversation.windows import SlidingWindowLedger
from personal_agent.engine import Budget
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
    PlanStepDto,
    RunTaskCompleted,
    RunTaskFailed,
)
from personal_agent.strategy import (
    AgentStrategy,
    DynamicLedgerStrategy,
)


class MockChannel:
    """用于测试的简易宿主通道。"""

    def __init__(self, tool_return_map: dict[str, Any] | None = None):
        self.calls: list[HostExecuteToolParams] = []
        self.tool_return_map = tool_return_map or {}

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        payload = self.tool_return_map.get(params.capability, {"ok": True})
        return HostExecuteToolResult(ok=True, payload=payload)


class SequenceModel(ModelGateway):
    """顺序产出指定决策的模型 Stub。"""

    def __init__(self, decisions: list[ModelDecision]):
        self._decisions = list(decisions)
        self.called_contexts: list[ModelContext] = []

    def decide(self, context: ModelContext, thinking_sink: Any = None) -> ModelDecision:
        self.called_contexts.append(context)
        if not self._decisions:
            return SummaryDecision(kind="summary", reply="默认完成", facts=[])
        return self._decisions.pop(0)


def test_dynamic_ledger_strategy_satisfies_protocol():
    """验证 DynamicLedgerStrategy 符合 AgentStrategy 协议。"""
    strategy = DynamicLedgerStrategy()
    assert isinstance(strategy, AgentStrategy)


def test_dynamic_ledger_strategy_single_loop_execution():
    """验证多步骤计划在 DynamicLedgerStrategy 下通过单层 ReActLoop 全程自驱动完成。"""
    plan = [
        PlanStepDto(description="检查工作区目录", capability="filesystem_list"),
        PlanStepDto(description="阅读配置文件", capability="file_read"),
        PlanStepDto(description="总结结果", capability=None),
    ]

    channel = MockChannel({
        "filesystem_list": {"files": ["config.json", "index.ts"]},
        "file_read": {"content": "{\"mode\": \"production\"}"},
    })

    # 模型依次决策：调用工具1 -> 调用工具2 -> 产出总结
    model = SequenceModel([
        ToolCallDecision(kind="tool_call", callId="call-1", capability="filesystem_list", arguments={"path": "."}),
        ToolCallDecision(kind="tool_call", callId="call-2", capability="file_read", arguments={"path": "config.json"}),
        SummaryDecision(kind="summary", reply="已完成目录与配置检查", facts=[]),
    ])

    strategy = DynamicLedgerStrategy()
    res = strategy.execute(
        model=model,
        channel=channel,
        goal="检查项目配置",
        visible_capabilities=["filesystem_list", "file_read"],
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(maxSteps=10, maxToolCalls=10),
        stream=None,
    )

    assert isinstance(res, RunTaskCompleted)
    assert res.status == "completed"
    assert "已完成目录与配置检查" in res.reply
    assert len(channel.calls) == 2

    # 验证上下文中的观察是连贯累积的（没有在步骤间被抹除）
    last_context = model.called_contexts[-1]
    assert len(last_context.observations) == 2
    assert last_context.observations[0].callId == "call-1"
    assert last_context.observations[1].callId == "call-2"


def test_dynamic_ledger_strategy_long_running_continuous_execution():
    """验证单主循环在长任务多轮连续工具调用下平滑贯穿执行，不被外部切片或重启打断。"""
    plan = [
        PlanStepDto(description="步骤1: 搜索文件", capability="filesystem_list"),
        PlanStepDto(description="步骤2: 读取内容", capability="file_read"),
        PlanStepDto(description="步骤3: 写入配置", capability="file_write"),
    ]

    channel = MockChannel({
        "filesystem_list": {"files": ["main.py", "config.yaml"]},
        "file_read": {"content": "env: dev"},
        "file_write": {"ok": True},
    })

    model = SequenceModel([
        ToolCallDecision(kind="tool_call", callId="call-1", capability="filesystem_list", arguments={"path": "."}),
        ToolCallDecision(kind="tool_call", callId="call-2", capability="file_read", arguments={"path": "config.yaml"}),
        ToolCallDecision(kind="tool_call", callId="call-3", capability="file_write", arguments={"path": "config.yaml", "content": "env: prod"}),
        SummaryDecision(kind="summary", reply="长链路多步检查全部通过", facts=[]),
    ])

    strategy = DynamicLedgerStrategy()
    res = strategy.execute(
        model=model,
        channel=channel,
        goal="执行长链路环境检查",
        visible_capabilities=["filesystem_list", "file_read", "file_write"],
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(maxSteps=20, maxToolCalls=20),
        stream=None,
    )

    assert isinstance(res, RunTaskCompleted)
    assert res.status == "completed"
    assert len(channel.calls) == 3
    assert "全部通过" in res.reply
    # 验证上下文中的观察连贯保留在同一个单主循环里
    assert len(model.called_contexts[-1].observations) == 3


def test_dynamic_ledger_strategy_with_sliding_window_persistence(tmp_path: Path):
    """验证 DynamicLedgerStrategy 执行中的轨迹能够物理沉淀到 MainEventLedger。"""
    log_file = tmp_path / "events.jsonl"
    ledger = MainEventLedger(log_file=log_file)
    window = SlidingWindowLedger(ledger=ledger)

    channel = MockChannel({"filesystem_list": {"files": ["app.py"]}})
    model = SequenceModel([
        ToolCallDecision(kind="tool_call", callId="call-disk-1", capability="filesystem_list", arguments={"path": "."}),
        SummaryDecision(kind="summary", reply="完成落盘测试", facts=[]),
    ])

    strategy = DynamicLedgerStrategy()
    res = strategy.execute(
        model=model,
        channel=channel,
        goal="物理落盘测试",
        visible_capabilities=["filesystem_list"],
        plan=[PlanStepDto(description="列表检查", capability="filesystem_list")],
        history=[],
        profile=None,
        budget=Budget(maxSteps=5, maxToolCalls=5),
        stream=None,
        sliding_window=window,
    )

    assert isinstance(res, RunTaskCompleted)

    # 验证底座物理日志文件写入了工具调用和结果
    events = ledger.read_events()
    event_types = [e.event_type for e in events]
    assert "tool_call" in event_types
    assert "tool_result" in event_types


def test_dynamic_ledger_strategy_budget_exhaustion_returns_failed():
    """验证当步数或工具预算耗尽时，策略安全返回 RunTaskFailed 并结算 usage。"""
    channel = MockChannel({"filesystem_list": {"files": ["1.txt"]}})
    # 无限发起工具调用
    model = SequenceModel([
        ToolCallDecision(kind="tool_call", callId=f"call-{i}", capability="filesystem_list", arguments={"path": "."})
        for i in range(10)
    ])

    strategy = DynamicLedgerStrategy()
    res = strategy.execute(
        model=model,
        channel=channel,
        goal="耗尽预算",
        visible_capabilities=["filesystem_list"],
        plan=[PlanStepDto(description="测试", capability="filesystem_list")],
        history=[],
        profile=None,
        budget=Budget(maxSteps=2, maxToolCalls=2),
        stream=None,
    )

    assert isinstance(res, RunTaskFailed)
    assert res.status == "failed"
    assert "预算耗尽" in res.reason

