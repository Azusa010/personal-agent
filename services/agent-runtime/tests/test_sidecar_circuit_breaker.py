"""拒绝熔断器状态机 (RejectionCircuitBreaker) 单元测试。"""

from personal_agent.conversation.sidecar.circuit_breaker import (
    RejectionCircuitBreaker,
)


def test_circuit_breaker_initial_state():
    cb = RejectionCircuitBreaker("task-test-1", threshold=3)
    assert cb.state == "CLOSED"
    assert cb.consecutive_rejections == 0
    can, reason = cb.can_execute()
    assert can is True
    assert reason is None


def test_circuit_breaker_below_threshold_returns_none():
    cb = RejectionCircuitBreaker("task-test-2", threshold=3)
    ev1 = cb.record_rejection("c-1", "filesystem_move", "目标已存在")
    assert ev1 is None
    assert cb.state == "CLOSED"
    assert cb.consecutive_rejections == 1

    ev2 = cb.record_rejection("c-2", "filesystem_move", "目标仍存在")
    assert ev2 is None
    assert cb.state == "CLOSED"
    assert cb.consecutive_rejections == 2


def test_circuit_breaker_trips_to_open_at_threshold():
    cb = RejectionCircuitBreaker("task-test-3", threshold=3)
    cb.record_rejection("c-1", "terminal_execute", "危险命令 1", "DESTRUCTIVE_COMMAND")
    cb.record_rejection("c-2", "terminal_execute", "危险命令 2", "DESTRUCTIVE_COMMAND")
    ev3 = cb.record_rejection("c-3", "terminal_execute", "危险命令 3", "DESTRUCTIVE_COMMAND")

    assert ev3 is not None
    assert ev3.state == "OPEN"
    assert ev3.taskId == "task-test-3"
    assert ev3.consecutiveRejections == 3
    assert len(ev3.recentRejections) == 3
    assert cb.state == "OPEN"

    can, reason = cb.can_execute()
    assert can is False
    assert "OPEN" in (reason or "")


def test_circuit_breaker_half_open_success_resets():
    cb = RejectionCircuitBreaker("task-test-4", threshold=2)
    cb.record_rejection("c-1", "terminal_execute", "bad 1")
    cb.record_rejection("c-2", "terminal_execute", "bad 2")
    assert cb.state == "OPEN"

    cb.reset_to_half_open()
    assert cb.state == "HALF_OPEN"
    can, _ = cb.can_execute()
    assert can is True

    cb.record_success()
    assert cb.state == "CLOSED"
    assert cb.consecutive_rejections == 0
    assert len(cb.recent_rejections) == 0


def test_circuit_breaker_half_open_rejection_reopens():
    cb = RejectionCircuitBreaker("task-test-5", threshold=2)
    cb.record_rejection("c-1", "terminal_execute", "bad 1")
    cb.record_rejection("c-2", "terminal_execute", "bad 2")
    assert cb.state == "OPEN"

    cb.reset_to_half_open()
    assert cb.state == "HALF_OPEN"

    ev = cb.record_rejection("c-probe", "terminal_execute", "probe rejected")
    assert cb.state == "OPEN"
    assert ev is not None
    assert ev.state == "OPEN"
    assert "半开试探" in ev.triggerReason


def test_circuit_breaker_sliding_window_capped():
    cb = RejectionCircuitBreaker("task-test-6", threshold=2)
    cb.record_rejection("c-1", "terminal_execute", "err 1")
    cb.record_rejection("c-2", "terminal_execute", "err 2")
    cb.record_rejection("c-3", "terminal_execute", "err 3")

    assert len(cb.recent_rejections) == 2
    assert cb.recent_rejections[0].callId == "c-2"
    assert cb.recent_rejections[1].callId == "c-3"
