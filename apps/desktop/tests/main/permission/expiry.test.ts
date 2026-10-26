import { describe, it, expect } from 'vitest'
import { PERMISSION_NEVER_EXPIRES_AT, type PermissionRecord } from '../../../src/shared/domain'
import {
  PERMISSION_TTL_MS,
  computeExpiresAt,
  permissionState
} from '../../../src/main/permission/expiry'

const REQUESTED = '2026-09-13T00:00:00.000Z'
const EXPIRES = '2026-09-13T00:05:00.000Z'

function record(status: PermissionRecord['status'], expiresAt = EXPIRES): PermissionRecord {
  return {
    id: 'p-1',
    taskId: 't-1',
    toolCallId: 'call-1',
    capability: 'filesystem_move',
    argsCanonical: '{}',
    argsHash: 'h',
    status,
    requestedAt: REQUESTED,
    expiresAt,
    decidedAt: status === 'pending' ? null : '2026-09-13T00:00:30.000Z',
    sourcePaths: [],
    targetPath: null
  }
}

describe('PERMISSION_TTL_MS', () => {
  it('默认不限期：没人点就一直等，不自动过期', () => {
    expect(PERMISSION_TTL_MS).toBeNull()
  })
})

describe('computeExpiresAt', () => {
  it('不限期时落到远期哨兵，而不是申请时间加五分钟', () => {
    expect(computeExpiresAt(REQUESTED)).toBe(PERMISSION_NEVER_EXPIRES_AT)
    expect(computeExpiresAt(REQUESTED, null)).toBe(PERMISSION_NEVER_EXPIRES_AT)
  })

  it('可以传自定义 TTL', () => {
    expect(computeExpiresAt(REQUESTED, 300_000)).toBe(EXPIRES)
    expect(computeExpiresAt(REQUESTED, 1000)).toBe('2026-09-13T00:00:01.000Z')
    expect(computeExpiresAt(REQUESTED, 0)).toBe(REQUESTED)
  })

  it('跨小时、跨天、跨年都正确进位', () => {
    expect(computeExpiresAt('2026-09-13T23:58:00.000Z', 300_000)).toBe('2026-09-14T00:03:00.000Z')
    expect(computeExpiresAt('2026-12-31T23:58:00.000Z', 300_000)).toBe('2027-01-01T00:03:00.000Z')
  })

  it('输出形状与 toISOString 一致，字典序才等价于时间序', () => {
    expect(computeExpiresAt(REQUESTED, 300_000)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    )
    expect(PERMISSION_NEVER_EXPIRES_AT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('permissionState：未过期时原样返回', () => {
  const now = '2026-09-13T00:01:00.000Z'

  it('pending', () => {
    expect(permissionState(record('pending'), now)).toBe('pending')
  })

  it('approved', () => {
    expect(permissionState(record('approved'), now)).toBe('approved')
  })

  it('denied', () => {
    expect(permissionState(record('denied'), now)).toBe('denied')
  })
})

describe('permissionState：过期投影', () => {
  const after = '2026-09-13T00:06:00.000Z'

  it('pending 超时投影成 expired', () => {
    expect(permissionState(record('pending'), after)).toBe('expired')
  })

  it('approved 超时也投影成 expired：批准了不放行就等于作废', () => {
    expect(permissionState(record('approved'), after)).toBe('expired')
  })

  it('denied 超时仍然是 denied：终局结论不被过期改写', () => {
    expect(permissionState(record('denied'), after)).toBe('denied')
  })
})

describe('permissionState：不限期窗口', () => {
  it('远期哨兵永远不会投影成 expired，pending 一直是 pending', () => {
    expect(
      permissionState(record('pending', PERMISSION_NEVER_EXPIRES_AT), '9999-01-01T00:00:00.000Z')
    ).toBe('pending')
  })

  it('已批准的不限期记录一直可放行', () => {
    expect(
      permissionState(record('approved', PERMISSION_NEVER_EXPIRES_AT), '9999-01-01T00:00:00.000Z')
    ).toBe('approved')
  })
})

describe('permissionState：过期边界', () => {
  it('now 恰好等于 expiresAt 不算过期', () => {
    expect(permissionState(record('approved'), EXPIRES)).toBe('approved')
  })

  it('now 比 expiresAt 大一毫秒就算过期', () => {
    expect(permissionState(record('approved'), '2026-09-13T00:05:00.001Z')).toBe('expired')
  })
})
