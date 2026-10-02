"""services/agent-runtime/tests/test_fault_recovery_bugs.py

针对 Bug Audit Report 模块一（故障恢复模块）的专项验收测试网：
- Bug 12: repair_trajectory_integrity 在 arguments=None 时防崩溃
- Bug 14: DeathSpiralProtector.enter() 超限时防深度泄漏
- Bug 3:  BatchToolCallDecision 压缩结果回填使用 compacted observation
- Bug 4:  BatchToolCallDecision 接入 ToolFingerprintDetector 重复调用指纹拦截
- Bug 2:  StreamStalledError 被 _decide_with_recovery 捕获并退避重试，而非直接崩溃
- Bug 5:  _fail() 不对 RecoveryPathBreaker 进行双重计数累加
- Bug 1:  Level 2 降级策略（compact_context）在 react_loop 中被有效调度与执行
"""

from unittest.mock import MagicMock

from personal_agent.conversation.context.manager import ContextManager
from personal_agent.conversation.loop.fault_classifier import (
    FaultLayer,
    RetryVerdict,
    StreamStalledError,
    classify_fault,
)
from personal_agent.conversation.loop.recovery import (
    RecoveryLevel,
    RecoveryPathBreaker,
    determine_recovery_plan,
)
from personal_agent.conversation.loop.trajectory import (
    DeathSpiralProtector,
    repair_trajectory_integrity,
)
from personal_agent.conversation.model.gateway import (
    BatchToolCallDecision,
    ModelCallFailed,
    Observation,
    SummaryDecision,
    ToolCallItem,
)
from personal_agent.conversation.sidecar.llm_client import SidecarCompactedObservation
from personal_agent.engine import Budget
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
)
from personal_agent.react_loop import ReActLoop
from personal_agent.scripted_model import ScriptedModel

VISIBLE = ["file_read", "file_write", "terminal_execute"]


class FakeChannel:
    def __init__(self, results=None):
        self._results = list(results or [])
        self.calls = []

    def call_host(self, params: HostExecuteToolParams):
        self.calls.append(params)
        if not self._results:
            return HostExecuteToolResult(ok=True, payload={"status": "ok"})
        item = self._results.pop(0)
        if isinstance(item, Exception):
            raise item
        return HostExecuteToolResult.model_validate(item)


# =========================================================================
# Bug 12: repair_trajectory_integrity 在 arguments=None 时的鲁棒性
# =========================================================================
def test_repair_trajectory_integrity_arguments_none_does_not_crash():
    """Bug 12: 当调用对象的 arguments 为 None 时，合成观察必须兜底为空字典，严禁抛 ValidationError。"""

    class LooseCall:
        callId = "call-none-args"
        capability = "terminal_execute"
        arguments = None

    report = repair_trajectory_integrity([LooseCall()], [])  # type: ignore[arg-type]
    assert report.has_repaired is True
    assert len(report.repaired_observations) == 1
    synth_obs = report.repaired_observations[0]
    assert synth_obs.callId == "call-none-args"
    assert synth_obs.capability == "terminal_execute"
    assert synth_obs.ok is False
    assert synth_obs.arguments == {}
    assert synth_obs.payload.get("error") == "broken_trajectory"


# =========================================================================
# Bug 14: DeathSpiralProtector.enter() 超限时防深度泄漏
# =========================================================================
def test_death_spiral_protector_no_depth_leak_on_rejection():
    """Bug 14: enter() 超限返回 False 时，不应泄漏自增深度导致深度永久卡死。"""
    protector = DeathSpiralProtector(max_depth=2)
    assert protector.enter() is True
    assert protector.depth == 1
    assert protector.enter() is True
    assert protector.depth == 2

    # 尝试超限进入：被拦截，depth 为 3
    assert protector.enter() is False
    assert protector.depth == 3

    # 调用 exit() 深度递减为 2，连续退出归零
    protector.exit()
    assert protector.depth == 2
    protector.exit()
    assert protector.depth == 1
    protector.exit()
    assert protector.depth == 0


# =========================================================================
# Bug 3: 批工具压缩结果回填用了未压缩对象
# =========================================================================
def test_batch_tool_compaction_records_compacted_observation():
    """Bug 3: 批工具执行后经 sidecar 压缩，写入 ContextManager 的必须是压缩后的 observation。"""
    mock_sidecar = MagicMock()
    mock_sidecar.compact_observation.return_value = SidecarCompactedObservation(
        callId="call-batch-1",
        capability="file_read",
        summary="批量调用成功输出",
        keyFacts=["关键数据点"],
        originalChars=8000,
        compactedChars=60,
    )

    calls = [
        BatchToolCallDecision(
            kind="batch_tool_call",
            calls=[
                ToolCallItem(
                    callId="call-batch-1",
                    capability="file_read",
                    arguments={"path": "large.txt"},
                )
            ],
        ),
        SummaryDecision(
            kind="summary",
            reply="完成",
            facts=[],
        ),
    ]
    model = ScriptedModel(calls)
    huge_output = "x" * 8000
    channel = FakeChannel([{"ok": True, "payload": {"text": huge_output}}])
    context = ContextManager()

    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=10, maxToolCalls=10),
        sidecar_llm=mock_sidecar,
    )
    outcome = loop.run("批工具测试", VISIBLE)
    assert outcome.kind == "completed"

    recorded_obs = context.observations
    assert len(recorded_obs) == 1
    # 验证录入上下文的是压缩后的摘要载荷，而非原始 5000 字符巨型 payload
    assert recorded_obs[0].payload.get("compacted") is True
    assert recorded_obs[0].payload.get("summary") == "批量调用成功输出"
    assert recorded_obs[0].payload.get("text") != huge_output


# =========================================================================
# Bug 4: 批工具调用完全绕过指纹防死循环
# =========================================================================
def test_batch_tool_duplicate_fingerprint_intercepted():
    """Bug 4: BatchToolCallDecision 中的重复调用必须被 ToolFingerprintDetector 拦截，不发起真实执行。"""
    # 批量发起 3 次完全相同的调用（默认 consecutive_limit=3，第 3 次触发拦截）
    batch_decision = BatchToolCallDecision(
        kind="batch_tool_call",
        calls=[
            ToolCallItem(
                callId="call-dup-1",
                capability="file_read",
                arguments={"path": "same.txt"},
            ),
            ToolCallItem(
                callId="call-dup-2",
                capability="file_read",
                arguments={"path": "same.txt"},
            ),
            ToolCallItem(
                callId="call-dup-3",
                capability="file_read",
                arguments={"path": "same.txt"},
            ),
        ],
    )

    model = ScriptedModel([
        batch_decision,
        SummaryDecision(kind="summary", reply="停止", facts=[]),
    ])
    channel = FakeChannel()
    context = ContextManager()

    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=10, maxToolCalls=10),
    )
    outcome = loop.run("防死循环测试", VISIBLE)
    assert outcome.kind == "completed"

    # 第三次调用不应该发给 host 执行，而是合成 duplicate_call 观察
    obs_list = context.observations
    assert len(obs_list) == 3
    # 前两次执行，第三次被拦截为 warning: duplicate_call
    dup_obs = obs_list[2]
    assert dup_obs.ok is False
    assert dup_obs.payload.get("warning") == "duplicate_call"
    # 确认 channel 只被调用了 2 次，第 3 次被短路未打到 channel
    assert len(channel.calls) == 2


# =========================================================================
# Bug 2: StreamStalledError 在 _decide_with_recovery 中被捕获并退避重试
# =========================================================================
def test_stream_stalled_error_is_recovered_with_retry():
    """Bug 2: 看门狗报警抛出 StreamStalledError 时，必须进入退避重试链路，而不是直接穿透导致任务失败。"""
    mock_model = MagicMock()
    # 第一次 decide 抛出 StreamStalledError，第二次重试成功返回 Summary
    mock_model.decide.side_effect = [
        StreamStalledError(idle_seconds=31.0, timeout_seconds=30.0),
        SummaryDecision(kind="summary", reply="超时重试成功", facts=[]),
    ]

    channel = FakeChannel()
    context = ContextManager()

    loop = ReActLoop(
        model=mock_model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=10, maxToolCalls=10),
    )
    outcome = loop.run("看门狗重试测试", VISIBLE)
    # 成功恢复并完成，而不是 failed
    assert outcome.kind == "completed"
    assert outcome.reply == "超时重试成功"


# =========================================================================
# Bug 5: _fail() 不对 RecoveryPathBreaker 重复记录失败
# =========================================================================
def test_path_breaker_no_double_count_on_failure():
    """Bug 5: 决策失败走到 _fail() 时，熔断器的失败计数不应被二次重复递增。"""
    mock_model = MagicMock()
    # 模拟一次 rate limit 故障，直接触发熔断（阈值设为 1）
    rate_limit_error = ModelCallFailed(
        reason="rate_limited: too many requests",
    )
    mock_model.decide.side_effect = rate_limit_error

    channel = FakeChannel()
    context = ContextManager()

    loop = ReActLoop(
        model=mock_model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=10, maxToolCalls=10),
    )
    # 将 silent_retry 的熔断阈值设为 1
    loop._path_breaker._thresholds["silent_retry"] = 1  # type: ignore[attr-defined]

    outcome = loop.run("单次失败熔断计数", VISIBLE)
    assert outcome.kind == "failed"

    # 单次任务尝试，熔断器计数只应为 1，绝不能因为 _fail() 二次递增为 2
    breaker = loop._path_breaker  # type: ignore[attr-defined]
    count = breaker.get_failure_count("silent_retry")
    assert count == 1, f"失败计数被重复累加: 期望为 1，实际为 {count}"


# =========================================================================
# Bug 1: Level 2 降级策略（compact_context）有效调度
# =========================================================================
def test_level_2_context_compression_degrades_and_retries():
    """Bug 1: 上下文溢出触发 Level 2 compact_context 时，应压缩上下文并重试，而不是直接抛出未捕获异常。"""
    mock_model = MagicMock()
    overflow_error = ModelCallFailed(
        reason="context_length_exceeded: maximum context length is 8192 tokens",
    )
    mock_model.decide.side_effect = [
        overflow_error,
        SummaryDecision(kind="summary", reply="压缩上下文后成功产出", facts=[]),
    ]

    channel = FakeChannel()
    context = ContextManager()

    loop = ReActLoop(
        model=mock_model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=10, maxToolCalls=10),
    )
    outcome = loop.run("测试上下文压缩降级", VISIBLE)
    assert outcome.kind == "completed"
    assert outcome.reply == "压缩上下文后成功产出"


# =========================================================================
# Bug 7: ValidationError 字符串被误判为 unknown_error (FATAL)
# =========================================================================
def test_fault_classifier_validation_error_string():
    """Bug 7: 字符串格式的 ValidationError（包含空格 'validation error'）应分类为 invalid_arguments，而非 unknown_error (FATAL)。"""
    res = classify_fault(
        "1 validation error for ToolCallDecision\narguments\n  Input should be a valid dictionary"
    )
    assert res.fault_type == "invalid_arguments"
    assert res.layer == FaultLayer.TOOL
    assert res.verdict == RetryVerdict.NON_RETRYABLE


# =========================================================================
# Bug 8: retry_after 正则单词边界误匹配
# =========================================================================
def test_fault_classifier_retry_after_word_boundary():
    """Bug 8: 'Awaiting response (status 500)' 中的 'wait' 不应误匹配提取 500 作为 retry_after。"""
    res = classify_fault("Awaiting response (status 500)")
    assert res.retry_after is None

    # 正常重试提示必须依然能提取
    res2 = classify_fault("Please wait 15.5s before retrying")
    assert res2.retry_after == 15.5

    res3 = classify_fault("Rate limited, retry after 3s")
    assert res3.retry_after == 3.0


# =========================================================================
# Bug 9: HostChannelClosed 与断管异常匹配
# =========================================================================
def test_fault_classifier_host_channel_closed_types():
    """Bug 9: HostChannelClosed 异常或 broken pipe 等断管表述应分类为 connection_reset (RETRYABLE)。"""

    class HostChannelClosed(Exception):
        pass

    res = classify_fault(HostChannelClosed("通道已关闭"))
    assert res.fault_type == "connection_reset"
    assert res.layer == FaultLayer.API
    assert res.verdict == RetryVerdict.RETRYABLE

    res2 = classify_fault("pipe broken while reading stdout")
    assert res2.fault_type == "connection_reset"


# =========================================================================
# Bug 10: compression_failed 与 broken_trajectory 的降级路径
# =========================================================================
def test_determine_recovery_plan_broken_trajectory_and_compression_failed():
    """Bug 10: broken_trajectory 与 compression_failed 作为 DEGRADABLE 故障，必须有对应的 Level 2 恢复动作，不能直接进入 halt_and_report。"""
    breaker = RecoveryPathBreaker()
    fault_traj = classify_fault("broken_trajectory: tool call without observation")
    plan_traj = determine_recovery_plan(fault_traj, breaker)
    assert plan_traj.level == RecoveryLevel.LEVEL_2_DEGRADE
    assert plan_traj.path == "trajectory_repair"
    assert plan_traj.action == "repair_trajectory"

    fault_comp = classify_fault("compression_failed: distiller model timeout")
    plan_comp = determine_recovery_plan(fault_comp, breaker)
    assert plan_comp.level == RecoveryLevel.LEVEL_2_DEGRADE
    assert plan_comp.path == "context_compression"
    assert plan_comp.action in ("compact_context", "truncate_fallback")


# =========================================================================
# Bug 13: 同 callId 历史观测不被覆盖丢失
# =========================================================================
def test_repair_trajectory_integrity_duplicate_call_id_fifo():
    """Bug 13: 历史观测中存在重复 callId 时，应按 FIFO 依次配对，未被匹配的多余观测全部保留，绝不被字典推导丢弃。"""
    calls = [
        ToolCallItem(callId="call-1", capability="file_read", arguments={"path": "a.txt"}),
        ToolCallItem(callId="call-1", capability="file_read", arguments={"path": "b.txt"}),
    ]
    obs1 = Observation(callId="call-1", capability="file_read", ok=True, payload={"step": 1})
    obs2 = Observation(callId="call-1", capability="file_read", ok=True, payload={"step": 2})

    report = repair_trajectory_integrity(calls, [obs1, obs2])
    assert len(report.repaired_observations) == 2
    assert report.repaired_observations[0].payload == {"step": 1}
    assert report.repaired_observations[1].payload == {"step": 2}
    assert report.repaired_call_ids == []

