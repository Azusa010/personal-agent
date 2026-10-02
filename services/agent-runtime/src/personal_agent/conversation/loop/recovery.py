"""
分级恢复链路与分路径熔断器。
依据 meta_capability_design_spec.md §2.3 与 §2.4。

- Level 1: 静默重试（指数退避 + 抖动 + Retry-After + 前后台区分）
- Level 2: 降级与接续（上下文溢出压缩、输出截断接续、工具层错误观察回灌自纠正）
- Level 3: 暴露给用户（分路径熔断触发或致命错误时的结构化升级）
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum

from personal_agent.conversation.loop.fault_classifier import (
    FaultClassification,
    FaultLayer,
    RetryVerdict,
)

# 默认分路径熔断阈值（来源：Claude Code 经验拐点与生产数据，§2.4 A）
DEFAULT_BREAKER_THRESHOLDS: dict[str, int] = {
    "silent_retry": 3,  # API 限流/抖动重试
    "context_compression": 3,  # 上下文压缩重试
    "output_continuation": 3,  # 输出接续重试
    "model_fallback": 2,  # 备用模型降级
    "permission_classify": 3,  # 权限分类人工回退
    "tool_self_heal": 3,  # 工具错误上下文回灌自愈
    "trajectory_repair": 3,  # 轨迹完整性修复
}


class RecoveryLevel(str, Enum):
    """三级恢复阶梯（§2.3）"""

    LEVEL_1_RETRY = "level_1_retry"  # 静默重试（对用户完全透明）
    LEVEL_2_DEGRADE = "level_2_degrade"  # 降级与接续（自愈/压缩/接续）
    LEVEL_3_ESCALATE = "level_3_escalate"  # 暴露给用户（熔断或致命错误）


class RecoveryPathBreaker:
    """分路径熔断器（§2.4 A）。每条恢复路径独立计数，互不干扰。"""

    def __init__(self, thresholds: dict[str, int] | None = None) -> None:
        self._counts: dict[str, int] = {}
        self._thresholds: dict[str, int] = dict(DEFAULT_BREAKER_THRESHOLDS)
        if thresholds:
            self._thresholds.update(thresholds)

    def record_failure(self, path: str) -> bool:
        """记录失败并递增计数器。返回 True 表示该路径已达到或超过熔断阈值。"""
        self._counts[path] = self._counts.get(path, 0) + 1
        threshold = self._thresholds.get(path, 3)
        return self._counts[path] >= threshold

    def record_success(self, path: str) -> None:
        """成功时重置该路径连续失败计数。"""
        self._counts[path] = 0

    def is_tripped(self, path: str) -> bool:
        """检查该路径当前是否处于熔断状态。"""
        threshold = self._thresholds.get(path, 3)
        return self._counts.get(path, 0) >= threshold

    def get_failure_count(self, path: str) -> int:
        """获取指定路径的当前连续失败次数。"""
        return self._counts.get(path, 0)

    def reset(self, path: str | None = None) -> None:
        """重置指定路径或所有路径的失败计数。"""
        if path is not None:
            self._counts[path] = 0
        else:
            self._counts.clear()


def compute_backoff_delay(
    attempt: int,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    factor: float = 2.0,
    jitter: bool = True,
    retry_after: float | None = None,
) -> float:
    """计算指数退避等待时间（秒）。

    规则：
    1. 若提供了显式 retry_after 且 > 0，优先尊重服务端建议值（上限为 max_delay）；
    2. 否则按 base_delay * (factor ** max(0, attempt - 1)) 计算；
    3. 若开启 jitter，在 [0.5 * delay, 1.5 * delay] 之间加入均匀随机扰动（避免惊群同步雪崩）；
    4. 结果严格限定在 [0.0, max_delay] 范围。
    """
    if retry_after is not None and retry_after > 0:
        return min(float(retry_after), max_delay)

    exp_delay = base_delay * (factor ** max(0, attempt - 1))
    if jitter:
        low = 0.5 * exp_delay
        high = 1.5 * exp_delay
        exp_delay = random.uniform(low, high)

    return min(max(0.0, exp_delay), max_delay)


@dataclass(frozen=True)
class RecoveryPlan:
    """恢复决策计划。描述针对当前故障应采取的恢复动作。"""

    level: RecoveryLevel
    path: str
    action: str  # retry, compact_context, continue_generation, feed_observation, abort_background, escalate_user, halt_and_report
    delay_seconds: float = 0.0
    reason: str = ""
    attempt: int = 1
    attempted_actions: list[str] = field(default_factory=list)


def determine_recovery_plan(
    fault: FaultClassification,
    breaker: RecoveryPathBreaker,
    attempt: int = 1,
    is_background: bool = False,
    attempted_actions: list[str] | None = None,
) -> RecoveryPlan:
    """根据故障分类与分路径熔断器状态，推导分级恢复方案。"""
    history = list(attempted_actions or [])
    if is_background:
        history.append("abort_background")
        return RecoveryPlan(
            level=RecoveryLevel.LEVEL_3_ESCALATE,
            path="abort_background",
            action="abort_background",
            reason="辅助性后台任务失败，终止以避免重试放大",
            attempt=attempt,
            attempted_actions=history,
        )
    if fault.verdict == RetryVerdict.RETRYABLE:
        path = "silent_retry"
        history.append("silent_retry")
        if breaker.record_failure(path):
            return RecoveryPlan(
                level=RecoveryLevel.LEVEL_3_ESCALATE,
                path=path,
                action="escalate_user",
                reason=f"路径 {path} 达到连续失败阈值，触发熔断升级",
                attempt=attempt,
                attempted_actions=history,
            )
        delay = compute_backoff_delay(attempt, retry_after=fault.retry_after)
        return RecoveryPlan(
            level=RecoveryLevel.LEVEL_1_RETRY,
            path=path,
            action="retry",
            delay_seconds=delay,
            reason=f"API 异常触发 Level 1 静默重试 (第 {attempt} 次)",
            attempt=attempt,
            attempted_actions=history,
        )

    # 3. Level 2 降级接续：上下文溢出压缩、输出截断接续、工具层异常回灌
    if (fault.fault_type == "context_overflow"
        or fault.fault_type == "compression_failed"
    ):
        path = "context_compression"
        action = "compact_context"
        reason_msg = "上下文长度溢出，触发上下文压缩"
    elif fault.fault_type == "broken_trajectory":
        path = "trajectory_repair"
        action = "repair_trajectory"
        reason_msg = "轨迹校验断裂，触发轨迹完整性修复"
    elif fault.fault_type == "output_truncated":
        path = "output_continuation"
        action = "continue_generation"
        reason_msg = "模型输出截断，触发接续生成"
    elif fault.layer == FaultLayer.TOOL:
        path = "tool_self_heal"
        action = "feed_observation"
        reason_msg = "工具执行异常，回灌错误观察以触发模型自纠正"
    else:
        path = None
        action = None
        reason_msg = ""
    if path is not None and action is not None:
        history.append(path)
        if breaker.record_failure(path):
            return RecoveryPlan(
                level=RecoveryLevel.LEVEL_3_ESCALATE,
                path=path,
                action="escalate_user",
                delay_seconds=0.0,
                reason=f"路径 {path} 达到连续失败阈值，触发熔断升级",
                attempt=attempt,
                attempted_actions=history,
            )
        return RecoveryPlan(
            level=RecoveryLevel.LEVEL_2_DEGRADE,
            path=path,
            action=action,
            delay_seconds=0.0,
            reason=reason_msg,
            attempt=attempt,
            attempted_actions=history,
        )
    # 4. Level 3 致命错误或不可恢复故障：终止并上报
    history.append(fault.fault_type)
    return RecoveryPlan(
        level=RecoveryLevel.LEVEL_3_ESCALATE,
        path=fault.fault_type,
        action="halt_and_report",
        delay_seconds=0.0,
        reason=f"致命或不可重试错误 [{fault.fault_type}]: {fault.message}",
        attempt=attempt,
        attempted_actions=history,
    )
