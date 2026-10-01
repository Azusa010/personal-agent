"""services/agent-runtime/tests/test_recovery.py

针对 recovery.py 的完整测试套件：
- RecoveryLevel 枚举与分级契约
- RecoveryPathBreaker 独立分路径熔断机制与重置
- compute_backoff_delay 指数退避、抖动范围与 retry_after 覆盖
- determine_recovery_plan 分级恢复决策状态机（前后台区分、Level 1/2/3 分流与熔断升级）
"""

from personal_agent.conversation.loop.fault_classifier import (
    FaultClassification,
    FaultLayer,
    RetryVerdict,
)
from personal_agent.conversation.loop.recovery import (
    RecoveryLevel,
    RecoveryPathBreaker,
    compute_backoff_delay,
    determine_recovery_plan,
)


def test_recovery_level_enum():
    """验证分级恢复层级枚举。"""
    assert [lvl.value for lvl in RecoveryLevel] == [
        "level_1_retry",
        "level_2_degrade",
        "level_3_escalate",
    ]


def test_recovery_path_breaker_independence_and_tripping():
    """验证分路径熔断器计数相互隔离，各自达到阈值时独立熔断。"""
    breaker = RecoveryPathBreaker({"model_fallback": 2, "context_compression": 3})

    assert not breaker.is_tripped("model_fallback")
    assert breaker.get_failure_count("model_fallback") == 0

    # 第一次失败：未达阈值 2
    tripped = breaker.record_failure("model_fallback")
    assert not tripped
    assert not breaker.is_tripped("model_fallback")
    assert breaker.get_failure_count("model_fallback") == 1

    # 第二次失败：触发熔断
    tripped = breaker.record_failure("model_fallback")
    assert tripped
    assert breaker.is_tripped("model_fallback")

    # 验证其他路径完全不受影响（隔离性）
    assert not breaker.is_tripped("context_compression")
    assert breaker.get_failure_count("context_compression") == 0


def test_recovery_path_breaker_success_and_reset():
    """验证成功时清零失败计数，以及全局/单路径 reset 方法。"""
    breaker = RecoveryPathBreaker({"silent_retry": 3})
    breaker.record_failure("silent_retry")
    breaker.record_failure("silent_retry")
    assert breaker.get_failure_count("silent_retry") == 2

    # 成功调用重置计数
    breaker.record_success("silent_retry")
    assert breaker.get_failure_count("silent_retry") == 0
    assert not breaker.is_tripped("silent_retry")

    # 单路径 reset
    breaker.record_failure("silent_retry")
    breaker.reset("silent_retry")
    assert breaker.get_failure_count("silent_retry") == 0

    # 全局 reset
    breaker.record_failure("p1")
    breaker.record_failure("p2")
    breaker.reset()
    assert breaker.get_failure_count("p1") == 0
    assert breaker.get_failure_count("p2") == 0


def test_compute_backoff_delay_exponential_no_jitter():
    """验证确定性指数退避计算与 max_delay 截断。"""
    # base=1.0, factor=2.0
    assert compute_backoff_delay(1, base_delay=1.0, factor=2.0, jitter=False) == 1.0
    assert compute_backoff_delay(2, base_delay=1.0, factor=2.0, jitter=False) == 2.0
    assert compute_backoff_delay(3, base_delay=1.0, factor=2.0, jitter=False) == 4.0
    assert compute_backoff_delay(4, base_delay=1.0, factor=2.0, jitter=False) == 8.0

    # 截断在 max_delay
    assert (
        compute_backoff_delay(10, base_delay=1.0, max_delay=15.0, factor=2.0, jitter=False)
        == 15.0
    )


def test_compute_backoff_delay_respects_retry_after():
    """验证服务端 retry_after 优先级高于指数退避计算。"""
    delay = compute_backoff_delay(1, retry_after=12.5, max_delay=30.0)
    assert delay == 12.5

    # 即使 retry_after 很大也会受到 max_delay 保护
    delay_capped = compute_backoff_delay(1, retry_after=60.0, max_delay=20.0)
    assert delay_capped == 20.0


def test_compute_backoff_delay_jitter_bounds():
    """验证开启抖动时，等待时间落在理论区间 [0.5 * delay, 1.5 * delay] 内。"""
    for _ in range(20):
        d = compute_backoff_delay(3, base_delay=2.0, factor=2.0, jitter=True)  # raw = 8.0
        assert 4.0 <= d <= 12.0


def test_determine_recovery_plan_background_abort():
    """验证辅助性后台任务失败时直接放弃重试，避免重试放大（§2.3）。"""
    fault = FaultClassification(
        fault_type="rate_limited",
        layer=FaultLayer.API,
        verdict=RetryVerdict.RETRYABLE,
        message="429 Too Many Requests",
    )
    breaker = RecoveryPathBreaker()

    plan = determine_recovery_plan(fault, breaker, attempt=1, is_background=True)
    assert plan.level == RecoveryLevel.LEVEL_3_ESCALATE
    assert plan.action == "abort_background"
    assert "重试放大" in plan.reason
    assert plan.delay_seconds == 0.0


def test_determine_recovery_plan_level_1_silent_retry():
    """验证 API 层可重试故障在熔断前推导为 Level 1 静默重试，带退避等待。"""
    fault = FaultClassification(
        fault_type="rate_limited",
        layer=FaultLayer.API,
        verdict=RetryVerdict.RETRYABLE,
        message="Rate limit exceeded",
        retry_after=5.0,
    )
    breaker = RecoveryPathBreaker({"silent_retry": 3})

    # attempt 1: 静默重试
    plan1 = determine_recovery_plan(fault, breaker, attempt=1)
    assert plan1.level == RecoveryLevel.LEVEL_1_RETRY
    assert plan1.path == "silent_retry"
    assert plan1.action == "retry"
    assert plan1.delay_seconds == 5.0
    assert "silent_retry" in plan1.attempted_actions

    # attempt 2: 再次失败
    plan2 = determine_recovery_plan(
        fault, breaker, attempt=2, attempted_actions=plan1.attempted_actions
    )
    assert plan2.level == RecoveryLevel.LEVEL_1_RETRY
    assert breaker.get_failure_count("silent_retry") == 2

    # attempt 3: 达到熔断阈值 3，升级为 Level 3
    plan3 = determine_recovery_plan(
        fault, breaker, attempt=3, attempted_actions=plan2.attempted_actions
    )
    assert plan3.level == RecoveryLevel.LEVEL_3_ESCALATE
    assert plan3.action == "escalate_user"
    assert "熔断" in plan3.reason


def test_determine_recovery_plan_level_2_context_overflow():
    """验证上下文溢出推导为 Level 2 context_compression 动作。"""
    fault = FaultClassification(
        fault_type="context_overflow",
        layer=FaultLayer.CONTEXT,
        verdict=RetryVerdict.DEGRADABLE,
        message="maximum context length exceeded",
    )
    breaker = RecoveryPathBreaker({"context_compression": 3})

    plan = determine_recovery_plan(fault, breaker)
    assert plan.level == RecoveryLevel.LEVEL_2_DEGRADE
    assert plan.path == "context_compression"
    assert plan.action == "compact_context"
    assert "压缩" in plan.reason

    # 连续失败 2 次后第 3 次触发熔断
    determine_recovery_plan(fault, breaker)
    plan_tripped = determine_recovery_plan(fault, breaker)
    assert plan_tripped.level == RecoveryLevel.LEVEL_3_ESCALATE
    assert plan_tripped.action == "escalate_user"


def test_determine_recovery_plan_level_2_output_truncated():
    """验证输出截断推导为 Level 2 output_continuation 动作。"""
    fault = FaultClassification(
        fault_type="output_truncated",
        layer=FaultLayer.API,
        verdict=RetryVerdict.DEGRADABLE,
        message="finish_reason: length",
    )
    breaker = RecoveryPathBreaker({"output_continuation": 3})

    plan = determine_recovery_plan(fault, breaker)
    assert plan.level == RecoveryLevel.LEVEL_2_DEGRADE
    assert plan.path == "output_continuation"
    assert plan.action == "continue_generation"


def test_determine_recovery_plan_level_2_tool_error_feedback():
    """验证工具层异常推导为 Level 2 feed_observation 回灌错误给模型自纠正。"""
    fault = FaultClassification(
        fault_type="tool_execution_error",
        layer=FaultLayer.TOOL,
        verdict=RetryVerdict.NON_RETRYABLE,
        message="HostRequestFailed: file not found",
    )
    breaker = RecoveryPathBreaker({"tool_self_heal": 3})

    plan = determine_recovery_plan(fault, breaker)
    assert plan.level == RecoveryLevel.LEVEL_2_DEGRADE
    assert plan.path == "tool_self_heal"
    assert plan.action == "feed_observation"
    assert "自纠正" in plan.reason

    # 连续工具失败熔断
    determine_recovery_plan(fault, breaker)
    plan_tripped = determine_recovery_plan(fault, breaker)
    assert plan_tripped.level == RecoveryLevel.LEVEL_3_ESCALATE
    assert plan_tripped.action == "escalate_user"


def test_determine_recovery_plan_level_3_fatal():
    """验证控制流致命错误直接推导为 Level 3 终止上报。"""
    fault = FaultClassification(
        fault_type="budget_exhausted",
        layer=FaultLayer.CONTROL,
        verdict=RetryVerdict.FATAL,
        message="预算耗尽",
    )
    breaker = RecoveryPathBreaker()

    plan = determine_recovery_plan(fault, breaker)
    assert plan.level == RecoveryLevel.LEVEL_3_ESCALATE
    assert plan.action == "halt_and_report"
    assert "致命" in plan.reason or "budget_exhausted" in plan.reason
