"""
test_fault_recovery_e2e.py
端到端故障恢复流水线集成测试 (TASK-A7)。
覆盖：
1. Level 1 临时故障静默重试与最终成功
2. Level 2 工具执行错误回灌自愈闭环
3. Level 3 分路径熔断超限并升级暴露给用户
4. 工具指纹死循环调用检测与轨迹配对完整性保证
"""

from personal_agent.context import ContextManager
from personal_agent.conversation.loop.fault_classifier import FaultLayer, RetryVerdict
from personal_agent.conversation.loop.recovery import (
    RecoveryLevel,
    RecoveryPathBreaker,
)
from personal_agent.conversation.loop.trajectory import (
    DeathSpiralProtector,
    ToolFingerprintDetector,
)
from personal_agent.conversation.model.gateway import ModelCallFailed
from personal_agent.engine import Budget
from personal_agent.model_gateway import SummaryDecision, ToolCallDecision
from personal_agent.protocol.models import HostExecuteToolParams, HostExecuteToolResult
from personal_agent.react_loop import ReActLoop
from personal_agent.scripted_model import ScriptedModel
from personal_agent.shared.host_channel import HostRequestFailed

VISIBLE_CAPABILITIES = ["filesystem_list", "file_read", "file_write"]


class FakeHostChannel:
    """受控的 HostChannel 替身，用于故障注入。"""

    def __init__(self, outcomes):
        self._outcomes = list(outcomes)
        self.calls: list[HostExecuteToolParams] = []

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        if not self._outcomes:
            raise AssertionError("FakeHostChannel 预设响应已耗尽")
        item = self._outcomes.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def test_fault_recovery_e2e_transient_retry_success(monkeypatch):
    """E2E-1: 偶发模型限流故障在 Level 1 静默重试后成功完成任务。"""
    monkeypatch.setattr("time.sleep", lambda s: None)
    call_count = 0

    class TransientFailingModel:
        def decide(self, context, on_thinking=None):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise ModelCallFailed("Rate limit 429: Too Many Requests")
            return SummaryDecision(
                kind="summary",
                reply="静默重试后成功完成任务",
                facts=[],
            )

    channel = FakeHostChannel([])
    model = TransientFailingModel()
    context = ContextManager(plan=())
    breaker = RecoveryPathBreaker(thresholds={"silent_retry": 3})

    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=5),
        path_breaker=breaker,
    )

    outcome = loop.run("重试任务", VISIBLE_CAPABILITIES)
    assert outcome.kind == "completed"
    assert outcome.reply == "静默重试后成功完成任务"
    assert call_count == 2
    assert breaker.get_failure_count("silent_retry") == 0


def test_fault_recovery_e2e_tool_error_self_healing():
    """E2E-2: 工具业务错误被回灌入上下文 (Level 2)，模型根据错误自愈推进完成。"""
    channel = FakeHostChannel(
        [
            # 第一次读取不存在的文件
            HostExecuteToolResult(ok=False, error="FILE_NOT_FOUND: config.json 不存在"),
            # 第二次模型自纠正读取备份文件
            HostExecuteToolResult(ok=True, content="backup config content"),
        ]
    )
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-try-1",
            capability="file_read",
            arguments={"path": "config.json"},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="call-try-2",
            capability="file_read",
            arguments={"path": "config.json.bak"},
        ),
        SummaryDecision(
            kind="summary",
            reply="原配置不存在，已成功自愈读取备份配置",
            facts=[],
        ),
    ]
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())

    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=5),
    )

    outcome = loop.run("读取配置文件", VISIBLE_CAPABILITIES)
    assert outcome.kind == "completed"
    assert "自愈读取备份配置" in outcome.reply
    assert len(context.observations) == 2
    assert context.observations[0].ok is False
    assert "FILE_NOT_FOUND" in str(context.observations[0].payload)
    assert context.observations[1].ok is True


def test_fault_recovery_e2e_circuit_breaker_escalates_to_user():
    """E2E-3: 工具自愈路径连续失败超过熔断阈值，自动升级到 Level 3 暴露给用户。"""
    # 连续 2 次内部异常导致工具自愈失败
    channel = FakeHostChannel(
        [
            HostRequestFailed("INTERNAL_ERROR", "Error 1"),
            HostRequestFailed("INTERNAL_ERROR", "Error 2"),
        ]
    )
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-fail-1",
            capability="file_write",
            arguments={"path": "sys.lock", "content": "1"},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="call-fail-2",
            capability="file_write",
            arguments={"path": "sys.lock", "content": "1"},
        ),
    ]
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())
    # 熔断阈值设置为 2
    breaker = RecoveryPathBreaker(thresholds={"tool_self_heal": 2})

    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=5),
        path_breaker=breaker,
    )

    outcome = loop.run("加锁操作", VISIBLE_CAPABILITIES)
    assert outcome.kind == "failed"
    assert breaker.is_tripped("tool_self_heal")
    assert outcome.recovery_plan is not None
    assert outcome.recovery_plan.level == RecoveryLevel.LEVEL_3_ESCALATE
    assert outcome.recovery_plan.action == "escalate_user"


def test_fault_recovery_e2e_duplicate_tool_call_loop_prevention():
    """E2E-4: 模型重复发起完全相同的参数调用时，指纹检测器就地阻断并安全推进。"""
    channel = FakeHostChannel(
        [
            HostExecuteToolResult(ok=True, content="done"),
        ]
    )
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="file_write",
            arguments={"path": "a.txt", "content": "hello"},
        ),
        # 第二次相同调用被拦截
        ToolCallDecision(
            kind="tool_call",
            callId="c-2",
            capability="file_write",
            arguments={"path": "a.txt", "content": "hello"},
        ),
        SummaryDecision(
            kind="summary",
            reply="重复调用已阻断并完成任务",
            facts=[],
        ),
    ]
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())
    detector = ToolFingerprintDetector(consecutive_limit=2)

    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=5),
        tool_detector=detector,
    )

    outcome = loop.run("防死循环测试", VISIBLE_CAPABILITIES)
    assert outcome.kind == "completed"
    assert outcome.reply == "重复调用已阻断并完成任务"
    assert len(channel.calls) == 1  # 拦截后不再打到宿主
    assert len(context.observations) == 2
    assert context.observations[1].ok is False
    assert context.observations[1].payload.get("warning") == "duplicate_call"


def test_fault_recovery_e2e_death_spiral_protection_terminates():
    """E2E-5: 恢复嵌套深度超过上限时，触发死亡螺旋防护并强制终止任务。"""
    channel = FakeHostChannel([HostRequestFailed("INTERNAL_ERROR", "Err")])
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem_list",
            arguments={},
        ),
    ]
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())
    protector = DeathSpiralProtector(max_depth=0)
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=5),
        death_spiral_protector=protector,
    )

    outcome = loop.run("死亡螺旋测试", VISIBLE_CAPABILITIES)
    assert outcome.kind == "failed"
    assert "死亡螺旋" in (outcome.reason or "")
    assert outcome.fault is not None
    assert outcome.fault.fault_type == "death_spiral"
    assert outcome.fault.layer == FaultLayer.CONTROL
    assert outcome.fault.verdict == RetryVerdict.FATAL

