"""拒绝熔断器状态机 (Rejection Circuit Breaker)

当连续工具调用被 Sidecar 拦截时，及时跳闸阻断 Agent 自主死循环重试，
并转交前端桌面发起人机审批诊断（Human-in-the-loop）。
"""

from personal_agent.protocol.models import (
    CircuitBreakerEvent,
    CircuitBreakerRejectionRecord,
    CircuitBreakerState,
    SidecarRiskCategory,
)
from personal_agent.shared import now_occurred_at

DEFAULT_CONSECUTIVE_REJECTION_THRESHOLD = 3


class RejectionCircuitBreaker:
    """拒绝熔断器状态机（Closed / Open / Half-Open）。"""

    def __init__(
        self,
        task_id: str,
        threshold: int = DEFAULT_CONSECUTIVE_REJECTION_THRESHOLD,
    ) -> None:
        self.task_id = task_id
        self.threshold = max(1, threshold)
        self.state: CircuitBreakerState = "CLOSED"
        self.consecutive_rejections: int = 0
        self.recent_rejections: list[CircuitBreakerRejectionRecord] = []

    def can_execute(self) -> tuple[bool, str | None]:
        """检查熔断器是否允许当前工具调用执行。"""
        if self.state == "OPEN":
            return (
                False,
                f"拒绝熔断器处于 OPEN 状态，已连续拦截 {self.consecutive_rejections} 次违规调用，需人工审核干预",
            )
        return True, None

    def record_success(self) -> None:
        """记录一次成功的工具执行。若处于 HALF_OPEN 则试探成功，状态闭合恢复。"""
        self.consecutive_rejections = 0
        self.recent_rejections.clear()
        self.state = "CLOSED"

    def reset_to_half_open(self, reason: str = "用户人工确认恢复试探") -> None:
        """从 OPEN 状态切为 HALF_OPEN（人机协同介入）。"""
        self.state = "HALF_OPEN"

    def record_rejection(
        self,
        call_id: str,
        capability: str,
        reason: str,
        risk_category: SidecarRiskCategory | None = None,
    ) -> CircuitBreakerEvent | None:
        """记录一次被 Sidecar 拦截的违规调用，并评估熔断器状态迁移。

        # Contract:
        #   - Input:
        #       call_id: str - 工具调用标识
        #       capability: str - 工具能力名称
        #       reason: str - 拦截理由
        #       risk_category: SidecarRiskCategory | None - 可选风险类型
        #   - Output:
        #       CircuitBreakerEvent | None - 若触发跳闸或处于已跳闸状态，返回事件结构体；若在安全阈值内，返回 None
        #   - Invariants:
        #       1. 构造 CircuitBreakerRejectionRecord 并维护最近违规记录列表：
        #          - 列表最大保留 self.threshold 条（超出时保留最新记录，滑动窗口）；
        #       2. 当 self.state == 'CLOSED' 时：
        #          - self.consecutive_rejections 递增 1；
        #          - 若 self.consecutive_rejections >= self.threshold：
        #            - 状态迁移为 self.state = 'OPEN'；
        #            - 构造并返回 CircuitBreakerEvent(taskId=self.task_id, state='OPEN', consecutiveRejections=self.consecutive_rejections, triggerReason=f"连续 {self.consecutive_rejections} 次工具调用被拦截，触发安全熔断", recentRejections=list(self.recent_rejections), occurredAt=now_occurred_at())；
        #          - 否则返回 None；
        #       3. 当 self.state == 'HALF_OPEN' 时：
        #          - 半开试探执行失败！
        #          - self.consecutive_rejections 递增 1；
        #          - 状态回退为 self.state = 'OPEN'；
        #          - 构造并返回 CircuitBreakerEvent(taskId=self.task_id, state='OPEN', consecutiveRejections=self.consecutive_rejections, triggerReason="半开试探调用再次被拦截，维持熔断跳闸状态", recentRejections=list(self.recent_rejections), occurredAt=now_occurred_at())；
        #       4. 当 self.state == 'OPEN' 时：
        #          - 已经处于跳闸状态，维持 'OPEN' 并返回当前事件；
        #   - Boundary conditions:
        #       - recent_rejections 必须为非空列表且长度不超过 self.threshold；
        #       - consecutive_rejections 必须严格非负；
        #   - Test file: services/agent-runtime/tests/test_sidecar_circuit_breaker.py
        """
        record = CircuitBreakerRejectionRecord(
            callId=call_id,
            capability=capability,
            reason=reason,
            riskCategory=risk_category,
        )
        self.recent_rejections.append(record)
        if len(self.recent_rejections) > self.threshold:
            self.recent_rejections.pop(0)  # 保留最近 self.threshold 条记录
        if self.state == "CLOSED":
            self.consecutive_rejections += 1
            if self.consecutive_rejections >= self.threshold:
                self.state = "OPEN"
                return CircuitBreakerEvent(
                    taskId=self.task_id,
                    state=self.state,
                    consecutiveRejections=self.consecutive_rejections,
                    triggerReason=f"连续 {self.consecutive_rejections} 次工具调用被拦截，触发安全熔断",
                    recentRejections=list(self.recent_rejections),
                    occurredAt=now_occurred_at(),
                )
            return None
        elif self.state == "HALF_OPEN":
            self.consecutive_rejections += 1
            self.state = "OPEN"
            return CircuitBreakerEvent(
                taskId=self.task_id,
                state=self.state,
                consecutiveRejections=self.consecutive_rejections,
                triggerReason="半开试探调用再次被拦截，维持熔断跳闸状态",
                recentRejections=list(self.recent_rejections),
                occurredAt=now_occurred_at(),
            )
        elif self.state == "OPEN":
            return CircuitBreakerEvent(
                taskId=self.task_id,
                state=self.state,
                consecutiveRejections=self.consecutive_rejections,
                triggerReason="已处于 OPEN 状态，维持熔断跳闸",
                recentRejections=list(self.recent_rejections),
                occurredAt=now_occurred_at(),
            )
        return None
