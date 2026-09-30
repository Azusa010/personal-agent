"""services/agent-runtime/tests/test_fault_classifier.py

针对 fault_classifier.py 的完整测试套件：
- 四层故障分类枚举与映射表完备性
- classify_fault 规则匹配、错误提取与 retry_after 解析
- StreamWatchdog 活性探测、超时报警与 sink 包装
"""

import time

import pytest

from personal_agent.conversation.loop.fault_classifier import (
    FAULT_CLASSIFICATION,
    FAULT_LAYER_MAP,
    FaultLayer,
    RetryVerdict,
    StreamStalledError,
    StreamWatchdog,
    classify_fault,
)
from personal_agent.conversation.model.gateway import ModelCallFailed, ScriptExhausted
from personal_agent.conversation.verification.summary import SummaryRejected
from personal_agent.shared import HostChannelClosed


def test_fault_layer_and_verdict_enums():
    """验证四层分层枚举与四种恢复判决枚举的成员值。"""
    assert [layer.value for layer in FaultLayer] == ["api", "tool", "context", "control"]
    assert [v.value for v in RetryVerdict] == ["retryable", "non_retryable", "degradable", "fatal"]


def test_fault_tables_integrity():
    """验证 FAULT_CLASSIFICATION 与 FAULT_LAYER_MAP 覆盖全部 16 类故障且类型匹配。"""
    expected_types = {
        # API 层
        "rate_limited",
        "server_overloaded",
        "request_timeout",
        "connection_reset",
        "output_truncated",
        # 上下文层
        "context_overflow",
        "compression_failed",
        "broken_trajectory",
        # 工具层
        "tool_not_found",
        "invalid_arguments",
        "tool_execution_error",
        "duplicate_call",
        # 控制流层
        "budget_exhausted",
        "circuit_breaker",
        "dead_loop",
        "death_spiral",
    }
    assert set(FAULT_CLASSIFICATION.keys()) == expected_types
    assert set(FAULT_LAYER_MAP.keys()) == expected_types

    # 校验各故障类型的层与恢复策略归属严格符合规范约定
    assert FAULT_CLASSIFICATION["rate_limited"] == RetryVerdict.RETRYABLE
    assert FAULT_LAYER_MAP["rate_limited"] == FaultLayer.API

    assert FAULT_CLASSIFICATION["server_overloaded"] == RetryVerdict.RETRYABLE
    assert FAULT_LAYER_MAP["server_overloaded"] == FaultLayer.API

    assert FAULT_CLASSIFICATION["request_timeout"] == RetryVerdict.RETRYABLE
    assert FAULT_LAYER_MAP["request_timeout"] == FaultLayer.API

    assert FAULT_CLASSIFICATION["connection_reset"] == RetryVerdict.RETRYABLE
    assert FAULT_LAYER_MAP["connection_reset"] == FaultLayer.API

    assert FAULT_CLASSIFICATION["output_truncated"] == RetryVerdict.DEGRADABLE
    assert FAULT_LAYER_MAP["output_truncated"] == FaultLayer.API

    assert FAULT_CLASSIFICATION["context_overflow"] == RetryVerdict.DEGRADABLE
    assert FAULT_LAYER_MAP["context_overflow"] == FaultLayer.CONTEXT

    assert FAULT_CLASSIFICATION["compression_failed"] == RetryVerdict.DEGRADABLE
    assert FAULT_LAYER_MAP["compression_failed"] == FaultLayer.CONTEXT

    assert FAULT_CLASSIFICATION["broken_trajectory"] == RetryVerdict.DEGRADABLE
    assert FAULT_LAYER_MAP["broken_trajectory"] == FaultLayer.CONTEXT

    assert FAULT_CLASSIFICATION["tool_not_found"] == RetryVerdict.NON_RETRYABLE
    assert FAULT_LAYER_MAP["tool_not_found"] == FaultLayer.TOOL

    assert FAULT_CLASSIFICATION["invalid_arguments"] == RetryVerdict.NON_RETRYABLE
    assert FAULT_LAYER_MAP["invalid_arguments"] == FaultLayer.TOOL

    assert FAULT_CLASSIFICATION["tool_execution_error"] == RetryVerdict.NON_RETRYABLE
    assert FAULT_LAYER_MAP["tool_execution_error"] == FaultLayer.TOOL

    assert FAULT_CLASSIFICATION["duplicate_call"] == RetryVerdict.NON_RETRYABLE
    assert FAULT_LAYER_MAP["duplicate_call"] == FaultLayer.TOOL

    assert FAULT_CLASSIFICATION["budget_exhausted"] == RetryVerdict.FATAL
    assert FAULT_LAYER_MAP["budget_exhausted"] == FaultLayer.CONTROL

    assert FAULT_CLASSIFICATION["circuit_breaker"] == RetryVerdict.FATAL
    assert FAULT_LAYER_MAP["circuit_breaker"] == FaultLayer.CONTROL

    assert FAULT_CLASSIFICATION["dead_loop"] == RetryVerdict.FATAL
    assert FAULT_LAYER_MAP["dead_loop"] == FaultLayer.CONTROL

    assert FAULT_CLASSIFICATION["death_spiral"] == RetryVerdict.FATAL
    assert FAULT_LAYER_MAP["death_spiral"] == FaultLayer.CONTROL


def test_classify_fault_direct_known_key():
    """验证传入标准 fault_type 字符串时直接命中映射。"""
    c = classify_fault("rate_limited")
    assert c.fault_type == "rate_limited"
    assert c.layer == FaultLayer.API
    assert c.verdict == RetryVerdict.RETRYABLE

    c2 = classify_fault("dead_loop")
    assert c2.fault_type == "dead_loop"
    assert c2.layer == FaultLayer.CONTROL
    assert c2.verdict == RetryVerdict.FATAL


def test_classify_fault_api_layer():
    """验证 API 层各类错误文本特征及 retry_after 提取。"""
    # 1. 429 限流带 retry_after
    res = classify_fault("Error 429: rate limit exceeded, retry after 12.5s")
    assert res.fault_type == "rate_limited"
    assert res.layer == FaultLayer.API
    assert res.verdict == RetryVerdict.RETRYABLE
    assert res.retry_after == 12.5

    # 2. 503 服务过载
    res = classify_fault("503 Service Unavailable: upstream server is overloaded")
    assert res.fault_type == "server_overloaded"
    assert res.layer == FaultLayer.API
    assert res.verdict == RetryVerdict.RETRYABLE

    # 3. 超时
    res = classify_fault("Request timed out after 30000ms")
    assert res.fault_type == "request_timeout"
    assert res.layer == FaultLayer.API
    assert res.verdict == RetryVerdict.RETRYABLE

    # 4. 连接中断
    res = classify_fault("Connection reset by peer (ECONNRESET)")
    assert res.fault_type == "connection_reset"
    assert res.layer == FaultLayer.API
    assert res.verdict == RetryVerdict.RETRYABLE

    # 5. 输出截断
    res = classify_fault("Model stopped generation due to output_truncated (finish_reason: length)")
    assert res.fault_type == "output_truncated"
    assert res.layer == FaultLayer.API
    assert res.verdict == RetryVerdict.DEGRADABLE


def test_classify_fault_context_layer():
    """验证 上下文层 故障分类。"""
    # 1. 窗口溢出
    res = classify_fault("maximum context length is 128000 tokens, but your request resulted in 131000 tokens")
    assert res.fault_type == "context_overflow"
    assert res.layer == FaultLayer.CONTEXT
    assert res.verdict == RetryVerdict.DEGRADABLE

    # 2. 压缩失败
    res = classify_fault("Context compression failed to reduce tokens below budget")
    assert res.fault_type == "compression_failed"
    assert res.layer == FaultLayer.CONTEXT
    assert res.verdict == RetryVerdict.DEGRADABLE

    # 3. 轨迹结构损坏
    res = classify_fault("Trajectory integrity violated: broken trajectory missing paired tool_result")
    assert res.fault_type == "broken_trajectory"
    assert res.layer == FaultLayer.CONTEXT
    assert res.verdict == RetryVerdict.DEGRADABLE


def test_classify_fault_tool_layer():
    """验证 工具层 故障分类。"""
    # 1. 工具不存在
    res = classify_fault("CAPABILITY_NOT_REGISTERED: capability unknown_tool 不在协议枚举内")
    assert res.fault_type == "tool_not_found"
    assert res.layer == FaultLayer.TOOL
    assert res.verdict == RetryVerdict.NON_RETRYABLE

    # 2. 参数非法
    res = classify_fault("ValidationError: 2 validation errors for FileMoveParams (invalid_arguments)")
    assert res.fault_type == "invalid_arguments"
    assert res.layer == FaultLayer.TOOL
    assert res.verdict == RetryVerdict.NON_RETRYABLE

    # 3. 工具执行异常
    res = classify_fault("HostRequestFailed: file not found on disk")
    assert res.fault_type == "tool_execution_error"
    assert res.layer == FaultLayer.TOOL
    assert res.verdict == RetryVerdict.NON_RETRYABLE

    # 4. 重复调用
    res = classify_fault("duplicate_call detected for tool file_write with identical parameters")
    assert res.fault_type == "duplicate_call"
    assert res.layer == FaultLayer.TOOL
    assert res.verdict == RetryVerdict.NON_RETRYABLE


def test_classify_fault_control_layer():
    """验证 控制流层 故障分类。"""
    # 1. 预算耗尽
    res = classify_fault("预算耗尽：已用 20 步 / 50 次工具调用")
    assert res.fault_type == "budget_exhausted"
    assert res.layer == FaultLayer.CONTROL
    assert res.verdict == RetryVerdict.FATAL

    # 2. 熔断器触发
    res = classify_fault("sidecar_rejection: circuit breaker tripped")
    assert res.fault_type == "circuit_breaker"
    assert res.layer == FaultLayer.CONTROL
    assert res.verdict == RetryVerdict.FATAL

    # 3. 死循环
    res = classify_fault("query_loop_detected: 连续多次发起高度相似检索")
    assert res.fault_type == "dead_loop"
    assert res.layer == FaultLayer.CONTROL
    assert res.verdict == RetryVerdict.FATAL

    # 4. 死亡螺旋
    res = classify_fault("death_spiral detected: error recovery recursion depth exceeded")
    assert res.fault_type == "death_spiral"
    assert res.layer == FaultLayer.CONTROL
    assert res.verdict == RetryVerdict.FATAL


def test_classify_fault_from_exception_instances():
    """验证传入异常实例时的解构与判定。"""
    # 1. ModelCallFailed
    mcf = ModelCallFailed("Rate limit reached. Please retry in 5s")
    res = classify_fault(mcf)
    assert res.fault_type == "rate_limited"
    assert res.layer == FaultLayer.API
    assert res.verdict == RetryVerdict.RETRYABLE
    assert res.retry_after == 5.0

    # 2. HostChannelClosed
    hcc = HostChannelClosed("Runtime channel closed by host")
    res = classify_fault(hcc)
    assert res.fault_type == "connection_reset"
    assert res.layer == FaultLayer.API

    # 3. SummaryRejected
    sr = SummaryRejected("Summary rejected: facts do not ground to retrieved pages")
    res = classify_fault(sr)
    assert res.fault_type == "tool_execution_error"
    assert res.layer == FaultLayer.TOOL

    # 4. ScriptExhausted
    se = ScriptExhausted(5)
    res = classify_fault(se)
    assert res.fault_type == "budget_exhausted"
    assert res.layer == FaultLayer.CONTROL

    # 5. StreamStalledError
    sse = StreamStalledError(idle_seconds=31.2, timeout_seconds=30.0)
    res = classify_fault(sse)
    assert res.fault_type == "request_timeout"
    assert res.layer == FaultLayer.API


def test_classify_fault_from_dict_payload():
    """验证传入字典 payload（如工具调用返回或中间通知）时的判定。"""
    p1 = {"code": "CAPABILITY_NOT_REGISTERED", "reason": "foo is not supported"}
    res1 = classify_fault(p1)
    assert res1.fault_type == "tool_not_found"

    p2 = {"warning": "query_loop_detected", "reason": "looping on query"}
    res2 = classify_fault(p2)
    assert res2.fault_type == "dead_loop"

    p3 = {"error": "sidecar_rejection", "reason": "gate rejected"}
    res3 = classify_fault(p3)
    assert res3.fault_type == "circuit_breaker"


def test_classify_fault_fallback():
    """验证无法识别的未知错误回退到兜底 FATAL 分类。"""
    res = classify_fault("An entirely random unknown system error occurred 987654")
    assert res.fault_type == "unknown_error"
    assert res.layer == FaultLayer.API
    assert res.verdict == RetryVerdict.FATAL


def test_stream_watchdog_liveness():
    """验证 StreamWatchdog 的心跳刷新与超时检测。"""
    watchdog = StreamWatchdog(idle_timeout_seconds=0.08)
    assert watchdog.check_alive() is True
    assert watchdog.idle_seconds >= 0.0

    # 等待超过 idle_timeout
    time.sleep(0.1)
    assert watchdog.check_alive() is False

    # 喂狗刷新心跳
    watchdog.feed()
    assert watchdog.check_alive() is True
    assert watchdog.idle_seconds < 0.05


def test_stream_watchdog_assert_alive():
    """验证 StreamWatchdog.assert_alive() 在超时时抛出 StreamStalledError。"""
    watchdog = StreamWatchdog(idle_timeout_seconds=0.05)
    watchdog.assert_alive()  # 不抛出

    time.sleep(0.07)
    with pytest.raises(StreamStalledError) as exc_info:
        watchdog.assert_alive()

    assert exc_info.value.idle_seconds >= 0.05
    assert exc_info.value.timeout_seconds == 0.05


def test_stream_watchdog_wrap_sink():
    """验证 StreamWatchdog.wrap_sink 包装函数能够自动喂狗。"""
    watchdog = StreamWatchdog(idle_timeout_seconds=0.1)
    collected = []

    def mock_sink(delta: str) -> None:
        collected.append(delta)

    wrapped = watchdog.wrap_sink(mock_sink)

    time.sleep(0.06)
    wrapped("first chunk")
    assert collected == ["first chunk"]
    # 因为 feed 了，此时应依然存活
    assert watchdog.idle_seconds < 0.04
    assert watchdog.check_alive() is True

    time.sleep(0.06)
    wrapped("second chunk")
    assert collected == ["first chunk", "second chunk"]
    assert watchdog.check_alive() is True

    # 停止调用超过 0.1s
    time.sleep(0.12)
    assert watchdog.check_alive() is False
