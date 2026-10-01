"""services/agent-runtime/src/personal_agent/conversation/loop/fault_classifier.py

四层故障分类学与错误恢复策略映射表，及流式响应活性看门狗。
依据 meta_capability_design_spec.md §2.1 与 §2.2。
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Any


class FaultLayer(str, Enum):
    """四层故障分层（§2.1）"""

    API = "api"  # 传输与服务端状态（429、过载、超时、断连、截断）
    TOOL = "tool"  # 能力层异常（工具未找到、参数非法、执行报错、重复调用）
    CONTEXT = "context"  # 上下文层（溢出、压缩失败、轨迹损坏）
    CONTROL = "control"  # 控制流层（死循环、死亡螺旋、预算耗尽、熔断）


class RetryVerdict(str, Enum):
    """恢复策略判定（§2.2 A）"""

    RETRYABLE = "retryable"  # 限流、过载、网络抖动 → 静默重试
    NON_RETRYABLE = "non_retryable"  # 参数非法、权限不足、工具不存在 → 改变输入
    DEGRADABLE = "degradable"  # 主模型不可用、上下文溢出、截断 → 降级接续或压缩
    FATAL = "fatal"  # 不可恢复（预算耗尽、熔断、死循环） → 终止并报告


# §2.2 A 故障恢复映射表
FAULT_CLASSIFICATION: dict[str, RetryVerdict] = {
    # API 层
    "rate_limited": RetryVerdict.RETRYABLE,
    "server_overloaded": RetryVerdict.RETRYABLE,
    "request_timeout": RetryVerdict.RETRYABLE,
    "connection_reset": RetryVerdict.RETRYABLE,
    "output_truncated": RetryVerdict.DEGRADABLE,
    # 上下文层
    "context_overflow": RetryVerdict.DEGRADABLE,
    "compression_failed": RetryVerdict.DEGRADABLE,
    "broken_trajectory": RetryVerdict.DEGRADABLE,
    # 工具层
    "tool_not_found": RetryVerdict.NON_RETRYABLE,
    "invalid_arguments": RetryVerdict.NON_RETRYABLE,
    "tool_execution_error": RetryVerdict.NON_RETRYABLE,
    "duplicate_call": RetryVerdict.NON_RETRYABLE,
    # 控制流层
    "budget_exhausted": RetryVerdict.FATAL,
    "circuit_breaker": RetryVerdict.FATAL,
    "dead_loop": RetryVerdict.FATAL,
    "death_spiral": RetryVerdict.FATAL,
}

FAULT_LAYER_MAP: dict[str, FaultLayer] = {
    "rate_limited": FaultLayer.API,
    "server_overloaded": FaultLayer.API,
    "request_timeout": FaultLayer.API,
    "connection_reset": FaultLayer.API,
    "output_truncated": FaultLayer.API,
    "context_overflow": FaultLayer.CONTEXT,
    "compression_failed": FaultLayer.CONTEXT,
    "broken_trajectory": FaultLayer.CONTEXT,
    "tool_not_found": FaultLayer.TOOL,
    "invalid_arguments": FaultLayer.TOOL,
    "tool_execution_error": FaultLayer.TOOL,
    "duplicate_call": FaultLayer.TOOL,
    "budget_exhausted": FaultLayer.CONTROL,
    "circuit_breaker": FaultLayer.CONTROL,
    "dead_loop": FaultLayer.CONTROL,
    "death_spiral": FaultLayer.CONTROL,
}


@dataclass(frozen=True)
class FaultClassification:
    """结构化故障分类结果"""

    fault_type: str
    layer: FaultLayer
    verdict: RetryVerdict
    message: str
    retry_after: float | None = None


class StreamStalledError(Exception):
    """流式连接活性超时（看门狗报警）"""

    def __init__(self, idle_seconds: float, timeout_seconds: float) -> None:
        super().__init__(
            f"流式响应卡死：闲置 {idle_seconds:.1f}s 超过阈值 {timeout_seconds:.1f}s"
        )
        self.idle_seconds = idle_seconds
        self.timeout_seconds = timeout_seconds


class StreamWatchdog:
    """流式响应活性看门狗（§2.2 C）。超过 idle_timeout 无新 token 则判定卡死。"""

    def __init__(self, idle_timeout_seconds: float = 30.0) -> None:
        self._idle_timeout = idle_timeout_seconds
        self._last_activity: float = time.monotonic()

    def feed(self) -> None:
        """每收到一个 token/chunk 时调用。"""
        self._last_activity = time.monotonic()

    def check_alive(self) -> bool:
        """检查是否超过空闲超时。"""
        return (time.monotonic() - self._last_activity) < self._idle_timeout

    @property
    def idle_seconds(self) -> float:
        return time.monotonic() - self._last_activity

    def assert_alive(self) -> None:
        """检查存活状态，若卡死则抛出 StreamStalledError。"""
        idle = self.idle_seconds
        if idle >= self._idle_timeout:
            raise StreamStalledError(idle, self._idle_timeout)

    def wrap_sink(self, sink: Callable[[str], None]) -> Callable[[str], None]:
        """包装 thinking sink，收到 token 增量时自动喂狗。"""

        def _wrapped(delta: str) -> None:
            self.feed()
            sink(delta)

        return _wrapped


def classify_fault(error: Any) -> FaultClassification:
    """四层故障分类与恢复策略判定。
    """
    msg = ""
    retry_after: float | None = None
    if isinstance(error, str):
        msg = error
        if error in FAULT_CLASSIFICATION:
            return FaultClassification(
                fault_type=error,
                layer=FAULT_LAYER_MAP[error],
                verdict=FAULT_CLASSIFICATION[error],
                message=msg,
            )
    elif isinstance(error, dict):
        msg = f"{error.get('code', '')} {error.get('error', '')} {error.get('warning', '')} {error.get('reason', '')} {error.get('message', '')}".strip()
    elif isinstance(error, StreamStalledError):
        msg = str(error)
        return FaultClassification(
            fault_type="request_timeout",
            layer=FaultLayer.API,
            verdict=RetryVerdict.RETRYABLE,
            message=msg,
        )
    elif isinstance(error, Exception):
        msg = str(error)
        if hasattr(error, "reason") and isinstance(error.reason, str):
            msg = f"{msg} {error.reason}".strip()
        if hasattr(error, "retry_after") and isinstance(
            error.retry_after, (int, float)
        ):
            retry_after = float(error.retry_after)
    else:
        msg = str(error)

    # 从错误信息中正则提取 retry_after（支持 "retry after 12.5s", "retry in 5s" 等）
    if retry_after is None:
        m = re.search(
            r"(?:retry[ -]?(?:after|in)|wait)[^\d]*(\d+(?:\.\d+)?)\s*s?",
            msg,
            re.IGNORECASE,
        )
        if m:
            try:
                retry_after = float(m.group(1))
            except (ValueError, IndexError):
                retry_after = None

    lower_msg = msg.lower()
    error_type = type(error).__name__.lower()

    # 1. 控制流层检测 (CONTROL)
    if (
        "budget_exhausted" in lower_msg
        or "scriptexhausted" in lower_msg
        or "scriptexhausted" in error_type
        or "预算耗尽" in msg
        or "脚本已用尽" in msg
    ):
        f_type = "budget_exhausted"
    elif (
        "circuit_breaker" in lower_msg
        or "sidecar_rejection" in lower_msg
        or "熔断" in msg
    ):
        f_type = "circuit_breaker"
    elif (
        "dead_loop" in lower_msg
        or "query_loop_detected" in lower_msg
        or "死循环" in msg
    ):
        f_type = "dead_loop"
    elif "death_spiral" in lower_msg or "死亡螺旋" in msg:
        f_type = "death_spiral"

    # 2. 上下文层检测 (CONTEXT)
    elif (
        "context_length_exceeded" in lower_msg
        or "maximum context length" in lower_msg
        or "context_overflow" in lower_msg
    ):
        f_type = "context_overflow"
    elif "compression_failed" in lower_msg or (
        "compression" in lower_msg and "failed" in lower_msg
    ):
        f_type = "compression_failed"
    elif "broken_trajectory" in lower_msg or "broken trajectory" in lower_msg:
        f_type = "broken_trajectory"

    # 3. 工具层检测 (TOOL)
    elif (
        "capability_not_registered" in lower_msg
        or "tool_not_found" in lower_msg
        or "不在协议枚举内" in msg
    ):
        f_type = "tool_not_found"
    elif "validationerror" in lower_msg or "invalid_arguments" in lower_msg:
        f_type = "invalid_arguments"
    elif "duplicate_call" in lower_msg:
        f_type = "duplicate_call"
    elif (
        "hostrequestfailed" in lower_msg
        or "hostrequestfailed" in error_type
        or "host 请求失败" in msg
        or "summaryrejected" in lower_msg
        or "summaryrejected" in error_type
        or "summary rejected" in lower_msg
        or "tool_execution_error" in lower_msg
    ):
        f_type = "tool_execution_error"

    # 4. API 层检测 (API)
    elif (
        "429" in msg
        or "rate limit" in lower_msg
        or "rate_limited" in lower_msg
        or "ratelimit" in lower_msg
        or "quota" in lower_msg
    ):
        f_type = "rate_limited"
    elif (
        "503" in msg
        or "502" in msg
        or "500" in msg
        or "server_overloaded" in lower_msg
        or "server overloaded" in lower_msg
        or "internal server error" in lower_msg
    ):
        f_type = "server_overloaded"
    elif (
        "timed out" in lower_msg
        or "timeout" in lower_msg
        or "request_timeout" in lower_msg
        or "408" in msg
        or "504" in msg
    ):
        f_type = "request_timeout"
    elif (
        "connection reset" in lower_msg
        or "econnreset" in lower_msg
        or "connection_reset" in lower_msg
        or "channel closed" in lower_msg
    ):
        f_type = "connection_reset"
    elif (
        "output_truncated" in lower_msg
        or "finish_reason: length" in lower_msg
        or "max_tokens" in lower_msg
    ):
        f_type = "output_truncated"

    # 5. 兜底
    else:
        return FaultClassification(
            fault_type="unknown_error",
            layer=FaultLayer.API,
            verdict=RetryVerdict.FATAL,
            message=msg,
            retry_after=retry_after,
        )

    return FaultClassification(
        fault_type=f_type,
        layer=FAULT_LAYER_MAP[f_type],
        verdict=FAULT_CLASSIFICATION[f_type],
        message=msg,
        retry_after=retry_after,
    )
