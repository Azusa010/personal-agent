"""test_sidecar_gating.py —— Sidecar 门控决策与路由逻辑测试。

全面验证 evaluate_sidecar_gate 在以下场景下的决策与状态协同：
1. ALLOW -> 放行 (proceed) 并记录成功重置熔断计数
2. REJECT_WITH_FEEDBACK -> 自愈 (self_heal)，携带修复指引与失败 Observation
3. 连续 REJECT 导致熔断器跳闸 -> 阻断 (halt)，抛出熔断事件
4. 熔断器已处于 OPEN 状态 -> 前置拦截直接阻断 (halt)
5. ESCALATE_TO_USER -> 判定需人工介入 (halt)
6. 未知 verdict -> fail-closed 阻断 (halt)
7. assessment 无 remediation 时自动调用 sidecar_llm 获取建议
"""

from unittest.mock import MagicMock

from personal_agent.conversation.sidecar.circuit_breaker import (
    RejectionCircuitBreaker,
)
from personal_agent.conversation.sidecar.gating import (
    SidecarGateResult,
    evaluate_sidecar_gate,
)
from personal_agent.protocol.models import SidecarAssessment
from personal_agent.shared import now_occurred_at


def test_sidecar_gate_allow_proceeds_and_records_success():
    """场景：Sidecar 放行，门控返回 proceed 并重置熔断计数。"""
    cb = RejectionCircuitBreaker(task_id="task-1", threshold=3)
    cb.consecutive_rejections = 1  # 模拟之前有一次违规

    assessment = SidecarAssessment(
        callId="call-1",
        capability="filesystem_list",
        verdict="ALLOW",
        riskCategory="NONE",
        reason="安全检查通过",
        assessedBy="jev",
        occurredAt=now_occurred_at(),
    )

    result = evaluate_sidecar_gate(
        assessment=assessment,
        circuit_breaker=cb,
        goal="查找文件",
        capability="filesystem_list",
        arguments={"rootId": "downloads"},
    )

    assert isinstance(result, SidecarGateResult)
    assert result.action == "proceed"
    assert result.observation is None
    assert result.halt_reason is None
    assert cb.consecutive_rejections == 0
    assert cb.state == "CLOSED"


def test_sidecar_gate_reject_with_feedback_self_heals():
    """场景：拦截单次调用，未达熔断阈值，返回 self_heal 并附带自愈 Observation。"""
    cb = RejectionCircuitBreaker(task_id="task-1", threshold=3)

    assessment = SidecarAssessment(
        callId="call-2",
        capability="filesystem_delete",
        verdict="REJECT_WITH_FEEDBACK",
        riskCategory="DESTRUCTIVE_COMMAND",
        reason="检测到高危目录删除操作",
        remediation="请仅删除特定临时文件，不要全量清除",
        assessedBy="jev",
        occurredAt=now_occurred_at(),
    )

    result = evaluate_sidecar_gate(
        assessment=assessment,
        circuit_breaker=cb,
        goal="清理目录",
        capability="filesystem_delete",
        arguments={"path": "/"},
    )

    assert isinstance(result, SidecarGateResult)
    assert result.action == "self_heal"
    assert result.observation is not None
    assert result.observation.callId == "call-2"
    assert result.observation.capability == "filesystem_delete"
    assert result.observation.ok is False
    assert result.observation.payload.get("error") == "sidecar_rejection"
    assert (
        result.observation.payload.get("remediation")
        == "请仅删除特定临时文件，不要全量清除"
    )
    assert cb.consecutive_rejections == 1
    assert cb.state == "CLOSED"


def test_sidecar_gate_reject_breaker_trips_to_halt():
    """场景：连续第 3 次被拦截，熔断器跳闸，门控返回 halt 并携带熔断事件。"""
    cb = RejectionCircuitBreaker(task_id="task-1", threshold=3)
    cb.consecutive_rejections = 2  # 已有两次拦截

    assessment = SidecarAssessment(
        callId="call-3",
        capability="host_exec",
        verdict="REJECT_WITH_FEEDBACK",
        riskCategory="SYSTEM_RESOURCE_ABUSE",
        reason="尝试修改系统核心注册表/系统文件",
        assessedBy="heuristic",
        occurredAt=now_occurred_at(),
    )

    result = evaluate_sidecar_gate(
        assessment=assessment,
        circuit_breaker=cb,
        goal="系统配置",
        capability="host_exec",
        arguments={"cmd": "reg add ..."},
    )

    assert isinstance(result, SidecarGateResult)
    assert result.action == "halt"
    assert cb.state == "OPEN"
    assert result.tripped_event is not None
    assert result.tripped_event.state == "OPEN"
    assert result.tripped_event.consecutiveRejections == 3
    assert result.halt_reason == result.tripped_event.triggerReason


def test_sidecar_gate_circuit_breaker_already_open_halts():
    """场景：熔断器已处于 OPEN 状态，前置检查直接阻断。"""
    cb = RejectionCircuitBreaker(task_id="task-1", threshold=3)
    cb.state = "OPEN"
    cb.consecutive_rejections = 3

    assessment = SidecarAssessment(
        callId="call-4",
        capability="filesystem_list",
        verdict="ALLOW",  # 即使本次评定 ALLOW，熔断器已跳闸也必须阻断
        riskCategory="NONE",
        reason="通过",
        assessedBy="jev",
        occurredAt=now_occurred_at(),
    )

    result = evaluate_sidecar_gate(
        assessment=assessment,
        circuit_breaker=cb,
        goal="任意目标",
        capability="filesystem_list",
        arguments={},
    )

    assert isinstance(result, SidecarGateResult)
    assert result.action == "halt"
    assert "拒绝熔断器处于 OPEN 状态" in (result.halt_reason or "")


def test_sidecar_gate_escalate_to_user_halts():
    """场景：评定为 ESCALATE_TO_USER，转交人工审批。"""
    cb = RejectionCircuitBreaker(task_id="task-1", threshold=3)

    assessment = SidecarAssessment(
        callId="call-5",
        capability="host_curl",
        verdict="ESCALATE_TO_USER",
        riskCategory="CREDENTIAL_EXFILTRATION",
        reason="检测到将凭据发送至外部未认证端点",
        assessedBy="jev",
        occurredAt=now_occurred_at(),
    )

    result = evaluate_sidecar_gate(
        assessment=assessment,
        circuit_breaker=cb,
        goal="上传报告",
        capability="host_curl",
        arguments={"url": "https://unknown-sink.com"},
    )

    assert isinstance(result, SidecarGateResult)
    assert result.action == "halt"
    assert "高风险操作需人工审批" in (result.halt_reason or "")


def test_sidecar_gate_unknown_verdict_fails_closed():
    """场景：未知的 verdict，fail-closed 终止。"""
    cb = RejectionCircuitBreaker(task_id="task-1", threshold=3)

    # 构造非法/未识别的 verdict（绕过 Pydantic construct）
    assessment = SidecarAssessment.model_construct(
        callId="call-6",
        capability="unknown_tool",
        verdict="UNKNOWN_VERDICT",  # type: ignore[arg-type]
        riskCategory="NONE",
        reason="未知审查判定",
        assessedBy="custom",
        occurredAt=now_occurred_at(),
    )

    result = evaluate_sidecar_gate(
        assessment=assessment,
        circuit_breaker=cb,
        goal="未知",
        capability="unknown_tool",
    )

    assert isinstance(result, SidecarGateResult)
    assert result.action == "halt"
    assert "未知的 Sidecar 审查结论" in (result.halt_reason or "")


def test_sidecar_gate_remediation_llm_fallback():
    """场景：assessment 未提供 remediation 时，自动调用 sidecar_llm 生成修复建议。"""
    cb = RejectionCircuitBreaker(task_id="task-1", threshold=3)

    mock_llm = MagicMock()
    mock_llm.generate_remediation.return_value = "建议改用只读查看命令"

    assessment = SidecarAssessment(
        callId="call-7",
        capability="filesystem_delete",
        verdict="REJECT_WITH_FEEDBACK",
        riskCategory="DESTRUCTIVE_COMMAND",
        reason="高危操作",
        remediation=None,  # 未自带建议
        assessedBy="jev",
        occurredAt=now_occurred_at(),
    )

    result = evaluate_sidecar_gate(
        assessment=assessment,
        circuit_breaker=cb,
        sidecar_llm=mock_llm,
        goal="检查文件",
        capability="filesystem_delete",
        arguments={"path": "important.txt"},
    )

    assert result.action == "self_heal"
    assert result.observation is not None
    assert result.observation.payload.get("remediation") == "建议改用只读查看命令"
    assert mock_llm.generate_remediation.call_count == 1
    call_args, call_kwargs = mock_llm.generate_remediation.call_args
    passed_goal = call_kwargs.get("goal") or (
        call_args[0] if len(call_args) > 0 else None
    )
    passed_cap = call_kwargs.get("capability") or (
        call_args[1] if len(call_args) > 1 else None
    )
    passed_args = call_kwargs.get("arguments") or (
        call_args[2] if len(call_args) > 2 else None
    )
    passed_reason = (
        call_kwargs.get("reason")
        or call_kwargs.get("rejection_reason")
        or (call_args[3] if len(call_args) > 3 else None)
    )
    assert passed_goal == "检查文件"
    assert passed_cap == "filesystem_delete"
    assert passed_args == {"path": "important.txt"}
    assert passed_reason == "高危操作"
