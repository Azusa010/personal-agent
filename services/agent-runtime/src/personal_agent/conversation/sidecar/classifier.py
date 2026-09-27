"""Jev 极速安全分类器与本地启发式兜底模块。

基于 TypeSafe System One (Jev) 模型实施毫秒级工具调用安全评估；
当 Jev 客户端未配置或调用异常时，平滑降级至本地确定性正则规则 (CON-006 fail-safe)。
"""

import json
import logging
import os
import re
from typing import Any

from personal_agent.protocol.models import (
    SidecarAssessment,
    SidecarRiskCategory,
    SidecarVerdict,
)
from personal_agent.shared import now_occurred_at

log = logging.getLogger("personal_agent.sidecar")

INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|prior)\s+instructions", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+in\s+developer\s+mode", re.IGNORECASE),
    re.compile(r"system\s+override\s+code", re.IGNORECASE),
    re.compile(r"bypass\s+(all\s+)?safety\s+checks", re.IGNORECASE),
]

SENSITIVE_PATH_PATTERNS = [
    re.compile(r"\b(id_rsa|id_ed25519)\b", re.IGNORECASE),
    re.compile(r"\.aws/credentials\b", re.IGNORECASE),
    re.compile(r"/etc/(shadow|passwd)\b", re.IGNORECASE),
    re.compile(r"\bWindows[/\\]System32[/\\]config[/\\]SAM\b", re.IGNORECASE),
]

FORBIDDEN_COMMAND_PATTERNS = [
    re.compile(r"\brm\s+(-rf?|-fr?)\s+[/~]", re.IGNORECASE),
    re.compile(r"\bmkfs\b", re.IGNORECASE),
    re.compile(r"\bdd\s+if=", re.IGNORECASE),
    re.compile(r"\bformat\s+[c-z]:", re.IGNORECASE),
    re.compile(r"\b(nc|netcat)\s+(-e|/bin)", re.IGNORECASE),
    re.compile(r"\bcurl\b.*\|\s*(bash|sh|powershell|iex)\b", re.IGNORECASE),
    re.compile(r"\bwget\b.*\|\s*(bash|sh)\b", re.IGNORECASE),
    re.compile(r"\bInvoke-Expression\b.*DownloadString", re.IGNORECASE),
    re.compile(r"\bshutdown\s+(-s|/s)", re.IGNORECASE),
]


def classify_heuristic(
    call_id: str,
    capability: str,
    arguments: dict[str, Any],
) -> SidecarAssessment:
    """本地启发式规则分类兜底（Tier 0 确定性规则）。"""
    content = json.dumps(arguments, ensure_ascii=False)

    for pattern in INJECTION_PATTERNS:
        if pattern.search(content):
            return SidecarAssessment(
                callId=call_id,
                capability=capability,
                verdict="ESCALATE_TO_USER",
                riskCategory="PROMPT_INJECTION",
                confidence=1.0,
                reason="检测到 Prompt 注入与越狱特征",
                remediation="请去除违规指令文本后重试",
                assessedBy="local-heuristic",
                occurredAt=now_occurred_at(),
            )

    for pattern in SENSITIVE_PATH_PATTERNS:
        if pattern.search(content):
            return SidecarAssessment(
                callId=call_id,
                capability=capability,
                verdict="ESCALATE_TO_USER",
                riskCategory="CREDENTIAL_EXFILTRATION",
                confidence=1.0,
                reason="检测到尝试读取系统敏感密钥或认证凭证",
                remediation="严禁访问系统密钥与凭证目录",
                assessedBy="local-heuristic",
                occurredAt=now_occurred_at(),
            )

    if capability in ("terminal_execute", "code_interpreter"):
        for pattern in FORBIDDEN_COMMAND_PATTERNS:
            if pattern.search(content):
                return SidecarAssessment(
                    callId=call_id,
                    capability=capability,
                    verdict="ESCALATE_TO_USER",
                    riskCategory="DESTRUCTIVE_COMMAND",
                    confidence=1.0,
                    reason="检测到高危毁灭性系统指令或反弹 Shell 特征",
                    remediation="高危系统指令已被系统阻断，必须获得管理员人工授权",
                    assessedBy="local-heuristic",
                    occurredAt=now_occurred_at(),
                )

    return SidecarAssessment(
        callId=call_id,
        capability=capability,
        verdict="ALLOW",
        riskCategory="NONE",
        confidence=0.9,
        reason="本地启发式安全规则校验通过",
        remediation=None,
        assessedBy="local-heuristic",
        occurredAt=now_occurred_at(),
    )


class JevSafetyClassifier:
    """基于 TypeSafe System One (Jev) 的极速安全分类器。"""

    def __init__(self, jev_client: Any | None = None) -> None:
        self._client = jev_client

    def _resolve_client(self) -> Any | None:
        if self._client is not None:
            return self._client
        api_key = os.environ.get("TYPESAFE_API_KEY", "").strip()
        if not api_key:
            return None
        try:
            from typesafe_sdk import TypeSafeClient

            self._client = TypeSafeClient()
            return self._client
        except Exception as err:  # noqa: BLE001
            log.warning("Sidecar TypeSafeClient 实例化失败: %s", err)
            return None

    def classify(
        self,
        call_id: str,
        capability: str,
        arguments: dict[str, Any],
        goal: str = "",
    ) -> SidecarAssessment:
        """评估单次工具调用的安全性。Jev 模型优先，失败时降级为本地规则。"""
        client = self._resolve_client()
        if client is None:
            return classify_heuristic(call_id, capability, arguments)

        try:
            from typesafe_sdk import Choice

            response = client.system_one(
                state={
                    "taskGoal": goal,
                    "capability": capability,
                    "arguments": arguments,
                },
                questions={
                    "verdict": Choice(
                        instructions="评估该工具调用在当前任务目标下的安全性和破坏性风险：",
                        criteria={
                            "allow": "操作安全合规，处于任务范围且无破坏性副作用（常规读取、合规受控写入）。",
                            "reject": "参数或逻辑存在错误、轻微越界或不合理，可通过纠偏指引引导自愈。",
                            "escalate": "高危破坏性操作（递归删除、不可逆覆盖、反弹Shell、凭据窃取、提示词注入逃逸），必须人工确认。",
                        },
                    )
                },
            )
            raw_choice = str(response.answers["verdict"].choice).strip().lower()

            if raw_choice == "allow":
                verdict: SidecarVerdict = "ALLOW"
                risk_cat: SidecarRiskCategory = "NONE"
                reason = "Jev 决策模型判定操作安全且符合当前任务意图"
                remediation = None
            elif raw_choice == "reject":
                verdict = "REJECT_WITH_FEEDBACK"
                risk_cat = "SCOPE_ESCAPING"
                reason = "Jev 决策模型判定参数存在逻辑缺陷或越界倾向"
                remediation = "请复核调用参数契约并纠正取值"
            else:
                verdict = "ESCALATE_TO_USER"
                risk_cat = "DESTRUCTIVE_COMMAND"
                reason = "Jev 决策模型判定该操作存在高危风险，需人工授权"
                remediation = "高风险操作，请人工复核"

            return SidecarAssessment(
                callId=call_id,
                capability=capability,
                verdict=verdict,
                riskCategory=risk_cat,
                confidence=0.96,
                reason=reason,
                remediation=remediation,
                assessedBy="jev-system-one",
                occurredAt=now_occurred_at(),
            )
        except Exception as err:  # noqa: BLE001
            log.warning("Jev 安全审查调用异常，降级为本地启发式规则: %s", err)
            return classify_heuristic(call_id, capability, arguments)
