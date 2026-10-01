export interface AuditMismatch {
  field: string
  expected: unknown
  actual: unknown
}

export interface AuditResult {
  hasMismatch: boolean
  mismatches: AuditMismatch[]
}

/**
 * 插件执行体内的 expected_* 双层审计逻辑。
 */
export function auditExpectedValues(
  callId: string,
  capability: string,
  expectations: Record<string, unknown>,
  actuals: Record<string, unknown>
): AuditResult {
  const mismatches: AuditMismatch[] = []

  for (const [key, expected] of Object.entries(expectations)) {
    if (expected === undefined || expected === null) continue
    if (expected !== actuals[key]) {
      mismatches.push({ field: key, expected, actual: actuals[key] })
      console.warn(
        `[AUDIT_MISMATCH] callId=${callId} capability=${capability} field=${key} expected=${expected} actual=${actuals[key]}`
      )
    }
  }
  return { hasMismatch: mismatches.length > 0, mismatches }
}
