"""
test_context_engineering_and_steering.py
SOTA 长程上下文工程与带外纠偏 (Context Engineering & System Reminder Steering) 测试套件。

涵盖：
1. 大输出截断白名单扩充（覆盖 content, stdout, stderr, output, snippet, summary）
2. 单主循环下滑动窗口安全边界探测解死锁（按工具交互轮次安全推进）
3. ModelContext 增加 systemReminders 契约支持
4. LiveModel / render_messages 末尾带外注入 <system-reminder> 标签
5. ReActLoop 单主循环基于预算消耗率（70% 预警 / 85% 紧迫）动态注入转向提醒，促成优雅收敛
"""

from collections.abc import Sequence
from typing import Any

from personal_agent.conversation.context.manager import (
    TRUNCATABLE_KEYS,
    TRUNCATION_MARKER,
    ContextManager,
    truncate_strings,
)
from personal_agent.conversation.loop.react_loop import ReActLoop
from personal_agent.conversation.model.gateway import (
    ModelContext,
    ModelGateway,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.conversation.model.live_model import render_messages
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
    PlanStepDto,
)
from personal_agent.shared import Budget, HostChannel

# ---------------------------------------------------------------------------
# 测试桩：Mock 通道与记录模型
# ---------------------------------------------------------------------------


class MockHostChannel(HostChannel):
    def __init__(self) -> None:
        self.calls: list[HostExecuteToolParams] = []

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        return HostExecuteToolResult(
            callId=params.callId,
            ok=True,
            model_extra={"status": "ok"},
        )


class SteeringRecorderModel(ModelGateway):
    """记录每次调用 decide 时收到的 ModelContext，并根据预设决策响应。"""

    def __init__(self, decisions: Sequence[Any]) -> None:
        self._decisions = list(decisions)
        self._idx = 0
        self.captured_contexts: list[ModelContext] = []

    def decide(self, context: ModelContext, thinking_sink=None) -> Any:
        self.captured_contexts.append(context)
        if self._idx >= len(self._decisions):
            return SummaryDecision(kind="summary", reply="默认总结收敛", facts=[])
        dec = self._decisions[self._idx]
        self._idx += 1
        return dec


# ---------------------------------------------------------------------------
# 1. 大输出截断白名单扩充测试
# ---------------------------------------------------------------------------


def test_truncatable_keys_covers_large_tool_outputs():
    """验证 TRUNCATABLE_KEYS 涵盖了所有长工具输出字段（content, stdout, stderr, output 等）。"""
    essential_keys = {"text", "reason", "content", "stdout", "stderr", "output", "summary"}
    assert essential_keys.issubset(TRUNCATABLE_KEYS)


def test_truncate_strings_truncates_large_tool_output_fields():
    """验证包含超大内容的字段会被安全截断，而非目标字段（路径、代码标识符）保持原样。"""
    large_payload = {
        "path": "src/very/long/path/to/source/file_controller.ts",
        "content": "A" * 5000,
        "stdout": "B" * 5000,
        "stderr": "C" * 5000,
        "output": "D" * 5000,
        "summary": "E" * 5000,
        "code": "OK_200",
        "exitCode": 0,
    }

    truncated = truncate_strings(large_payload, limit=100)

    # 白名单内的长字符串必须被截断
    assert len(truncated["content"]) == 100 + len(TRUNCATION_MARKER)
    assert truncated["content"].endswith(TRUNCATION_MARKER)
    assert len(truncated["stdout"]) == 100 + len(TRUNCATION_MARKER)
    assert len(truncated["stderr"]) == 100 + len(TRUNCATION_MARKER)
    assert len(truncated["output"]) == 100 + len(TRUNCATION_MARKER)
    assert len(truncated["summary"]) == 100 + len(TRUNCATION_MARKER)

    # 关键标识符不能被截断
    assert truncated["path"] == "src/very/long/path/to/source/file_controller.ts"
    assert truncated["code"] == "OK_200"
    assert truncated["exitCode"] == 0





# ---------------------------------------------------------------------------
# 3. ModelContext 与 LiveModel 的 <system-reminder> 带外注入测试
# ---------------------------------------------------------------------------


def test_model_context_system_reminders_contract():
    """验证 ModelContext 字段支持 systemReminders 列表。"""
    ctx = ModelContext(
        taskGoal="测试任务",
        systemReminders=["<system-reminder>警告：步数预算消耗 70%</system-reminder>"],
    )
    assert len(ctx.systemReminders) == 1
    assert "70%" in ctx.systemReminders[0]


def test_render_messages_injects_system_reminder_at_tail():
    """验证 render_messages 将 systemReminders 作为独立的 user 提醒追加在消息流末尾。"""
    ctx = ModelContext(
        taskGoal="测试目标",
        systemReminders=["步数预算即将耗尽（剩余 2 步），请立即收敛作答。"],
    )
    messages = render_messages(ctx)

    # 最后一个消息应是包含 <system-reminder> 的带外提醒
    last_msg = messages[-1]
    assert last_msg["role"] == "user"
    assert "<system-reminder>" in last_msg["content"]
    assert "</system-reminder>" in last_msg["content"]
    assert "步数预算即将耗尽" in last_msg["content"]


# ---------------------------------------------------------------------------
# 4. ReActLoop 单主循环基于预算动态转向全链路测试
# ---------------------------------------------------------------------------


def test_react_loop_dynamic_budget_steering_warnings():
    """验证在单主循环中，随着步数消耗，ReActLoop 自动在 70% 和 85% 预算节点注入系统预警，指引模型收敛。"""
    channel = MockHostChannel()

    # 预算设为 10 步：
    # 步数 1..6: 正常执行
    # 步数 7 (70%): 应收到黄色预警
    # 步数 9 (90%): 应收到红色预警
    # 步数 10: 模型收到紧急预警后决定不再调用工具，给出 SummaryDecision 优雅收尾
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId=f"call-{i}",
            capability="file_read",
            arguments={"path": f"file_{i}.txt"},
        )
        for i in range(1, 10)
    ]
    # 第 10 步：模型根据提醒给出总结
    decisions.append(SummaryDecision(kind="summary", reply="任务在预算耗尽前成功收敛完成", facts=[]))

    model = SteeringRecorderModel(decisions)
    plan = [PlanStepDto(description="探索并处理文件", capability="file_read")]
    context = ContextManager(plan=plan, history=[], profile=None, task_goal="批量文件扫描")

    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=10, maxToolCalls=15),
    )

    outcome = loop.run(goal="批量文件扫描", visible_capabilities=["file_read"])

    # 验证任务在达到 10 步时是 completed 而不是 budget_exhausted 抛错
    assert outcome.kind == "completed"
    assert "任务在预算耗尽前成功收敛完成" in outcome.reply

    # 验证模型在决策过程中收到的 ModelContext 确实收到了带外提醒
    # 第 7 步决策（索引 6）及之后应该携带 70% 警告
    context_step_7 = model.captured_contexts[6]
    reminders_7 = getattr(context_step_7, "systemReminders", [])
    assert any("70%" in r for r in reminders_7)

    # 第 9 步决策（索引 8）应携带紧急预警
    context_step_9 = model.captured_contexts[8]
    reminders_9 = getattr(context_step_9, "systemReminders", [])
    assert any("即将耗尽" in r or "紧急" in r or "剩余" in r for r in reminders_9)
