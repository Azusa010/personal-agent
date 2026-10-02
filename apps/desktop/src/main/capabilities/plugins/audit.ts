export interface AuditMismatch {
  field: string
  expected: unknown
  actual: unknown
}

export interface AuditResult {
  hasMismatch: boolean
  mismatches: AuditMismatch[]
}

export interface AuditRecord {
  callId: string
  capability: string
  mismatches: AuditMismatch[]
  timestamp: string
}

const auditHistory: AuditRecord[] = []
export type AuditMismatchListener = (record: AuditRecord) => void
const auditListeners: Set<AuditMismatchListener> = new Set()

export function getAuditHistory(): readonly AuditRecord[] {
  return auditHistory
}

export function clearAuditHistory(): void {
  auditHistory.length = 0
}

export function addAuditMismatchListener(listener: AuditMismatchListener): () => void {
  auditListeners.add(listener)
  return () => {
    auditListeners.delete(listener)
  }
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

  const hasMismatch = mismatches.length > 0
  if (hasMismatch) {
    const record: AuditRecord = {
      callId,
      capability,
      mismatches,
      timestamp: new Date().toISOString()
    }
    auditHistory.push(record)
    for (const listener of auditListeners) {
      try {
        listener(record)
      } catch (err) {
        console.error('[AUDIT_LISTENER_ERROR]', err)
      }
    }
  }

  return { hasMismatch, mismatches }
}
