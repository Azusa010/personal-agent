import { describe, expect, it, vi } from 'vitest'

import { ERROR_CODE } from '@personal-agent/protocol'

import type { PermissionRecord, PermissionViewState } from '../../shared/domain'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'
import type {
  PermissionBroker,
  PermissionOutcome,
  PermissionVerifyResult,
  RespondResult
} from './permission-broker'
import {
  listTaskPermissions,
  respondToPermission,
  type PermissionRespondInput
} from './permission-ipc'

type PermissionEntry = { permission: PermissionRecord; state: PermissionViewState }

const RECORD: PermissionRecord = {
  id: 'perm-1',
  taskId: 'task-1',
  toolCallId: 'tc-9f3a',
  capability: 'filesystem.create_dir',
  argsCanonical: '{"path":"D:/downloads/reports"}',
  argsHash: 'a1b2c3d4e5f60718293a',
  status: 'pending',
  requestedAt: '2026-09-07T08:00:00.000Z',
  expiresAt: '2026-09-07T08:05:00.000Z',
  decidedAt: null,
  sourcePaths: [],
  targetPath: 'D:/downloads/reports'
}

// 每个 stub 都显式标返回类型：不标的话 vi.fn 会把 `ok: true` 推成 boolean，
// 判别联合就匹不上了。本文件只测 respond 与 listForTask，其余三个给空壳。
function fakeBroker(overrides: Partial<PermissionBroker> = {}): PermissionBroker {
  return {
    request: vi.fn(async (): Promise<PermissionOutcome> => ({
      approved: true,
      permission: RECORD
    })),
    respond: vi.fn((): RespondResult => ({ ok: true, permission: RECORD, repeated: false })),
    verify: vi.fn(async (): Promise<PermissionVerifyResult> => ({ ok: true })),
    listForTask: vi.fn((): PermissionEntry[] => []),
    dispose: vi.fn(),
    ...overrides
  }
}

describe('respondToPermission: 入参收窄', () => {
  const cases: Array<[string, PermissionRespondInput]> = [
    ['缺 permissionId', { decision: 'approved' }],
    ['permissionId 是空串', { permissionId: '', decision: 'approved' }],
    ['permissionId 不是字符串', { permissionId: 42, decision: 'approved' }],
    ['permissionId 是 null', { permissionId: null, decision: 'approved' }],
    ['缺 decision', { permissionId: 'perm-1' }],
    ['decision 是空串', { permissionId: 'perm-1', decision: '' }],
    ['decision 不在枚举里', { permissionId: 'perm-1', decision: 'maybe' }],
    ['decision 是布尔', { permissionId: 'perm-1', decision: true }],
    ['两个都缺', {}]
  ]

  it.each(cases)('%s → PROTOCOL_INVALID_REQUEST，且不碰 broker', (_label, input) => {
    const broker = fakeBroker()

    const result = respondToPermission(input, { broker })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
    expect(broker.respond).not.toHaveBeenCalled()
  })

  it('失败信息里带上收到的值，否则无从判断是 renderer 传错还是 preload 漏参', () => {
    const result = respondToPermission(
      { permissionId: 'perm-1', decision: 'maybe' },
      {
        broker: fakeBroker()
      }
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('maybe')
  })
})

describe('respondToPermission: broker 结论透传', () => {
  it('批准成功时 permission 与 repeated 原样带出', () => {
    const decided: PermissionRecord = {
      ...RECORD,
      status: 'approved',
      decidedAt: '2026-09-07T08:00:10.000Z'
    }
    const broker = fakeBroker({
      respond: vi.fn((): RespondResult => ({ ok: true, permission: decided, repeated: false }))
    })

    const result = respondToPermission({ permissionId: 'perm-1', decision: 'approved' }, { broker })

    expect(result).toEqual({ ok: true, permission: decided, repeated: false })
    expect(broker.respond).toHaveBeenCalledWith('perm-1', 'approved', undefined)
  })

  it('传入非空 reason 时正确透传给 broker.respond', () => {
    const decided: PermissionRecord = {
      ...RECORD,
      status: 'denied',
      decidedAt: '2026-09-07T08:01:00.000Z'
    }
    const broker = fakeBroker({
      respond: vi.fn((): RespondResult => ({ ok: true, permission: decided, repeated: false }))
    })

    const result = respondToPermission(
      { permissionId: 'perm-1', decision: 'denied', reason: '改存到其他目录' },
      { broker }
    )

    expect(result).toEqual({ ok: true, permission: decided, repeated: false })
    expect(broker.respond).toHaveBeenCalledWith('perm-1', 'denied', '改存到其他目录')
  })

  it('repeated=true 不被吞掉：UI 要靠它区分「新结论」与「早就决定过」', () => {
    const broker = fakeBroker({
      respond: vi.fn((): RespondResult => ({ ok: true, permission: RECORD, repeated: true }))
    })

    const result = respondToPermission({ permissionId: 'perm-1', decision: 'denied' }, { broker })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repeated).toBe(true)
  })

  it.each([
    ['PERMISSION_REQUIRED', ERROR_CODE.PERMISSION_REQUIRED],
    ['PERMISSION_DENIED', ERROR_CODE.PERMISSION_DENIED],
    ['PERMISSION_EXPIRED', ERROR_CODE.PERMISSION_EXPIRED],
    ['PERMISSION_TAMPERED', ERROR_CODE.PERMISSION_TAMPERED]
  ])('%s 原样透传，reason 改名成 message', (_label, code) => {
    const broker = fakeBroker({
      respond: vi.fn((): RespondResult => ({ ok: false, code, reason: `因为 ${code}` }))
    })

    const result = respondToPermission({ permissionId: 'perm-1', decision: 'approved' }, { broker })

    expect(result).toEqual({ ok: false, code, message: `因为 ${code}` })
  })

  it('白名单之外的码收成 DB_FAILED，不把 UI 查不到的字符串推上去', () => {
    const broker = fakeBroker({
      respond: vi.fn((): RespondResult => ({
        ok: false,
        code: 'SOMETHING_NEW',
        reason: '新码没登记'
      }))
    })

    const result = respondToPermission({ permissionId: 'perm-1', decision: 'approved' }, { broker })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(RUNTIME_ERROR_CODE.DB_FAILED)
    // 原因照样带出去：码收白了，文本不能一起丢，否则排查时什么线索都没有
    expect(result.message).toBe('新码没登记')
  })
})

describe('respondToPermission: broker 抛异常', () => {
  it('Error 收成 DB_FAILED，message 取 err.message', () => {
    const broker = fakeBroker({
      respond: vi.fn(() => {
        throw new Error('database is locked')
      })
    })

    const result = respondToPermission({ permissionId: 'perm-1', decision: 'approved' }, { broker })

    expect(result).toEqual({
      ok: false,
      code: RUNTIME_ERROR_CODE.DB_FAILED,
      message: 'database is locked'
    })
  })

  it('抛的不是 Error 也不炸，String() 兜住', () => {
    const broker = fakeBroker({
      respond: vi.fn(() => {
        throw 'boom'
      })
    })

    const result = respondToPermission({ permissionId: 'perm-1', decision: 'approved' }, { broker })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(RUNTIME_ERROR_CODE.DB_FAILED)
    expect(result.message).toBe('boom')
  })
})

describe('listTaskPermissions', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空串', ''],
    ['数字', 7],
    ['对象', { taskId: 'task-1' }]
  ])('taskId 是 %s → PROTOCOL_INVALID_REQUEST，且不碰 broker', (_label, taskId) => {
    const broker = fakeBroker()

    const result = listTaskPermissions(taskId, { broker })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
    expect(broker.listForTask).not.toHaveBeenCalled()
  })

  it('entries 原样带出，state 是投影值而不是库里的 status', () => {
    // expired 只存在于投影里：库里那条的 status 仍是 pending。
    // 这一层要是把 state 换成 status，诊断表就永远看不到「已过期」。
    const broker = fakeBroker({
      listForTask: vi.fn((): PermissionEntry[] => [
        { permission: RECORD, state: 'expired' },
        { permission: { ...RECORD, id: 'perm-2' }, state: 'approved' }
      ])
    })

    const result = listTaskPermissions('task-1', { broker })

    expect(broker.listForTask).toHaveBeenCalledWith('task-1')
    expect(result).toEqual({
      ok: true,
      entries: [
        { permission: RECORD, state: 'expired' },
        { permission: { ...RECORD, id: 'perm-2' }, state: 'approved' }
      ]
    })
  })

  it('没有记录时返回空数组，不是 null 也不是失败', () => {
    const result = listTaskPermissions('task-1', { broker: fakeBroker() })

    expect(result).toEqual({ ok: true, entries: [] })
  })

  it('broker 抛异常收成 DB_FAILED', () => {
    const broker = fakeBroker({
      listForTask: vi.fn(() => {
        throw new Error('no such table: permissions')
      })
    })

    const result = listTaskPermissions('task-1', { broker })

    expect(result).toEqual({
      ok: false,
      code: RUNTIME_ERROR_CODE.DB_FAILED,
      message: 'no such table: permissions'
    })
  })
})
