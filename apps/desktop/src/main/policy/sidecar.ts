import type { SidecarAssessment, SidecarRiskCategory } from '@personal-agent/protocol'

export interface SidecarInspectionResult {
  readonly safe: boolean
  readonly reason?: string
  readonly tags?: string[]
}

export interface SidecarActionAllow {
  kind: 'allow'
}

export interface SidecarActionReject {
  kind: 'reject'
  reason: string
  remediation: string
}

export interface SidecarActionEscalate {
  kind: 'escalate'
  reason: string
  riskCategory: SidecarRiskCategory
}

export type SidecarAction = SidecarActionAllow | SidecarActionReject | SidecarActionEscalate

export const DEFAULT_REMEDIATION_MESSAGE = '请检查调用参数契约并重试'
export const DEFAULT_ESCALATE_FALLBACK_RISK: SidecarRiskCategory = 'DESTRUCTIVE_COMMAND'
export const LOW_CONFIDENCE_ESCALATE_REASON = '置信度不足，强制升级为人工核验'

/**
 * 将协议层的 Sidecar 审查判决包 (SidecarAssessment) 解析为执行层的具体动作 (SidecarAction)。
 *
 * # Contract:
 * #   - Input: assessment: SidecarAssessment (协议层安全判定结构体)
 * #   - Output: SidecarAction ('allow' | 'reject' | 'escalate')
 * #   - Invariants:
 * #       1. 当 assessment.verdict === 'ALLOW' 时：
 * #          - 若 assessment.confidence >= 0.5，返回 { kind: 'allow' }；
 * #          - 若 assessment.confidence < 0.5，判定为置信度不可靠（防假阴性），强制升级为：
 * #            { kind: 'escalate', reason: LOW_CONFIDENCE_ESCALATE_REASON, riskCategory: assessment.riskCategory === 'NONE' ? DEFAULT_ESCALATE_FALLBACK_RISK : assessment.riskCategory }；
 * #       2. 当 assessment.verdict === 'REJECT_WITH_FEEDBACK' 时：
 * #          - 返回 { kind: 'reject', reason: assessment.reason, remediation: <纠偏建议> }；
 * #          - 边界保护：若 assessment.remediation 为 null/undefined 或纯空白串，使用 DEFAULT_REMEDIATION_MESSAGE 兜底；
 * #       3. 当 assessment.verdict === 'ESCALATE_TO_USER' 时：
 * #          - 返回 { kind: 'escalate', reason: assessment.reason, riskCategory: <风险类别> }；
 * #          - 边界保护：若 assessment.riskCategory === 'NONE'，归一化修正为 DEFAULT_ESCALATE_FALLBACK_RISK；
 * #   - Boundary conditions:
 * #       - 无论 verdict 是什么，只要置信度 < 0.5 且原本打算放行，必须 Fail-Closed 降级为 escalate；
 * #       - 空建议与无风险高危必须有确定性兜底，不能透传空字符串或 NONE 给审批流；
 * #   - Test file: apps/desktop/src/main/policy/sidecar.test.ts
 */
export function resolveSidecarAction(assessment: SidecarAssessment): SidecarAction {
  switch (assessment.verdict) {
    case 'ALLOW':
      if (assessment.confidence >= 0.5) {
        return { kind: 'allow' }
      } else {
        return {
          kind: 'escalate',
          reason: LOW_CONFIDENCE_ESCALATE_REASON,
          riskCategory:
            assessment.riskCategory === 'NONE'
              ? DEFAULT_ESCALATE_FALLBACK_RISK
              : assessment.riskCategory
        }
      }
    case 'REJECT_WITH_FEEDBACK':
      const remediation = assessment.remediation?.trim() ?? ''
      return {
        kind: 'reject',
        reason: assessment.reason,
        remediation: remediation || DEFAULT_REMEDIATION_MESSAGE
      }
    case 'ESCALATE_TO_USER':
      return {
        kind: 'escalate',
        reason: assessment.reason,
        riskCategory:
          assessment.riskCategory === 'NONE'
            ? DEFAULT_ESCALATE_FALLBACK_RISK
            : assessment.riskCategory
      }
  }
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /system\s+override\s+code/i,
  /bypass\s+(all\s+)?safety\s+checks/i
]

const FORBIDDEN_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-rf?|-fr?)\s+[/~]/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bformat\s+[c-z]:/i,
  /\b(nc|netcat)\s+(-e|\/bin)/i,
  /\bcurl\b.*\|\s*(bash|sh|powershell|iex)\b/i,
  /\bwget\b.*\|\s*(bash|sh)\b/i,
  /\bInvoke-Expression\b.*DownloadString/i,
  /\bshutdown\s+(-s|\/s)/i
]

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /\b(id_rsa|id_ed25519)\b/i,
  /\.aws\/credentials\b/i,
  /\/etc\/(shadow|passwd)\b/i,
  /\bWindows[\\/]System32[\\/]config[\\/]SAM\b/i
]

/**
 * 轻量级 Sidecar 行为分类器原型（第 4 章：执行工具安全防御层次）。
 * 伴随工具调用并行审查纯结构化参数，阻断 Prompt 注入逃逸、危险系统指令与敏感机密窃取。
 */
export function inspectCallSecurity(
  capability: string,
  args: Record<string, unknown>
): SidecarInspectionResult {
  const content = JSON.stringify(args)

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return {
        safe: false,
        reason: '检测到 Prompt 注入逃逸特征，拒绝执行',
        tags: ['PROMPT_INJECTION_DETECTED']
      }
    }
  }

  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(content)) {
      return {
        safe: false,
        reason: '检测到试图访问核心系统凭证或密钥，拒绝执行',
        tags: ['SENSITIVE_CREDENTIAL_ACCESS']
      }
    }
  }

  if (capability === 'terminal_execute' || capability === 'code_interpreter') {
    for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
      if (pattern.test(content)) {
        return {
          safe: false,
          reason: '检测到高危毁灭性系统命令或反弹 Shell 特征，拒绝执行',
          tags: ['DESTRUCTIVE_COMMAND_DETECTED']
        }
      }
    }
  }

  return { safe: true }
}
