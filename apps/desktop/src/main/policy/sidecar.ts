export interface SidecarInspectionResult {
  readonly safe: boolean
  readonly reason?: string
  readonly tags?: string[]
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
