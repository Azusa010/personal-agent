"""Sidecar 门控评估与决策路由 (Sidecar Gate Evaluation)

负责在 ReAct 循环中整合 StreamBarrier、RejectionCircuitBreaker 与 SidecarLlmClient，
根据 SidecarAssessment 做出三种行动路由：
- proceed: 放行并调用底层宿主能力
- self_heal: 拦截并合成带有修复指引 (Remediation) 的失败 Observation 喂回 ReAct 上下文
- halt: 跳闸或需人工审批，终止自主循环转交前端
"""

from dataclasses import dataclass
from typing import Any, Literal

from personal_agent.conversation.model.gateway import Observation
from personal_agent.conversation.sidecar.circuit_breaker import RejectionCircuitBreaker
from personal_agent.conversation.sidecar.llm_client import SidecarLlmClient
from personal_agent.protocol.models import CircuitBreakerEvent, SidecarAssessment


@dataclass
class SidecarGateResult:
    """Sidecar 门控决策路由结果。"""

    action: Literal["proceed", "self_heal", "halt"]
    observation: Observation | None = None
    halt_reason: str | None = None
    tripped_event: CircuitBreakerEvent | None = None


def evaluate_sidecar_gate(
    assessment: SidecarAssessment,
    circuit_breaker: RejectionCircuitBreaker,
    sidecar_llm: SidecarLlmClient | None = None,
    goal: str = "",
    capability: str = "",
    arguments: dict[str, Any] | None = None,
) -> SidecarGateResult:
    """评估 Sidecar 审查结果并决定 ReAct 循环流向。

    # Contract:
    #   - Input:
    #       assessment: SidecarAssessment - 极速审查评估结果 (verdict: ALLOW | REJECT_WITH_FEEDBACK | ESCALATE_TO_USER)
    #       circuit_breaker: RejectionCircuitBreaker - 拒绝熔断器状态机实例
    #       sidecar_llm: SidecarLlmClient | None - 可选的独立 LLM 客户端（用于生成修复建议）
    #       goal: str - 任务总目标
    #       capability: str - 工具能力名称
    #       arguments: dict[str, Any] | None - 工具参数字典
    #   - Output:
    #       SidecarGateResult 包含 action ("proceed" | "self_heal" | "halt"), observation, halt_reason, tripped_event
    """
    args = arguments or {}
    can_exec, breaker_reason = circuit_breaker.can_execute()
    if not can_exec:
        return SidecarGateResult(
            action="halt",
            halt_reason=breaker_reason,
        )
    if assessment.verdict == "ALLOW":
        circuit_breaker.record_success()
        return SidecarGateResult(action="proceed")
    elif assessment.verdict == "REJECT_WITH_FEEDBACK":
        tripped = circuit_breaker.record_rejection(
            call_id=assessment.callId,
            capability=capability,
            reason=assessment.reason,
            risk_category=assessment.riskCategory,
        )
        if tripped is not None:
            return SidecarGateResult(
                action="halt",
                halt_reason=tripped.triggerReason,
                tripped_event=tripped,
            )
        remediation = (
            assessment.remediation
            or (sidecar_llm.generate_remediation(goal, capability, args, assessment.reason) if sidecar_llm else None)
            or "操作被安全防护系统拦截，请调整参数或使用替代能力重试。"
        )
        synthetic_obs = Observation(
            callId=assessment.callId,
            capability=capability,
            ok=False,
            payload={
                "error": "sidecar_rejection",
                "riskCategory": assessment.riskCategory,
                "reason": assessment.reason,
                "remediation": remediation,
            },
            arguments=args,
        )
        return SidecarGateResult(action="self_heal", observation=synthetic_obs)
    elif assessment.verdict == "ESCALATE_TO_USER":
        return SidecarGateResult(
            action="halt",
            halt_reason=f"高风险操作需人工审批: {assessment.reason}",
        )
    else:
        return SidecarGateResult(
            action="halt",
            halt_reason=f"未知的 Sidecar 审查结论: {assessment.verdict}",
        )