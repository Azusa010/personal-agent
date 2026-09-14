import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { ERROR_CODE } from '@personal-agent/protocol'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExecutionEventRecord, PermissionRecord } from '../../shared/domain'
import {
  migrate,
  MEMORY_DB,
  openProductState,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePermissionRepository } from '../product-state/permission-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { fingerprintArguments } from './args-hash'
import { PERMISSION_TTL_MS } from './expiry'
import {
  createPermissionBroker,
  PERMISSION_EVENT,
  verifyPermission,
  type PermissionBroker,
  type PermissionBrokerDeps,
  type PermissionNotice,
  type PermissionRequestInput
} from './permission-broker'

const T0 = '2026-09-14T09:00:00.000Z'
const TASK_ID = 't-1'

let tmpRoot = ''
let posixRoot = ''

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'pa-broker-'))
  posixRoot = tmpRoot.split(sep).join('/')
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 })
})

let db: SqliteDatabase | null = null
let clock = T0
let idSeq = 0
let broker: PermissionBroker | null = null
let notices: PermissionNotice[] = []

beforeEach(() => {
  clock = T0
  idSeq = 0
  notices = []
  vi.useFakeTimers()
})

afterEach(() => {
  broker?.dispose()
  broker = null
  db?.close()
  db = null
  vi.useRealTimers()
})

function openBroker(overrides: Partial<PermissionBrokerDeps> = {}): PermissionBroker {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  new SqliteTaskRepository(d).insert({
    id: TASK_ID,
    goal: '整理下载目录',
    status: 'running',
    createdAt: T0,
    updatedAt: T0
  })

  const made = createPermissionBroker({
    permissions: new SqlitePermissionRepository(d),
    events: new SqliteEventRepository(d),
    now: () => clock,
    newId: () => `perm-${++idSeq}`,
    ttlMs: 1000,
    root: () => posixRoot,
    notify: (notice) => notices.push(notice),
    ...overrides
  })
  broker = made
  return made
}

function events(): ExecutionEventRecord[] {
  if (db === null) throw new Error('数据库没开')
  return new SqliteEventRepository(db).listByTask(TASK_ID)
}

function stored(): PermissionRecord[] {
  if (db === null) throw new Error('数据库没开')
  return new SqlitePermissionRepository(db).findByTaskId(TASK_ID)
}

function eventsOfType(type: string): ExecutionEventRecord[] {
  return events().filter((event) => event.type === type)
}

/** move 的绑定结果：source 是根内真实文件，target 是根内还不存在的目标 */
function moveBound(
  source: string,
  target: string
): { args: Record<string, string>; paths: Record<string, string> } {
  return {
    args: { source, target },
    paths: { source, target }
  }
}

function dirBound(path: string): { args: Record<string, string>; paths: Record<string, string> } {
  return { args: { path }, paths: { path } }
}

/** 不能在模块顶层写成常量：那时 beforeAll 还没跑，posixRoot 是空串，
 *  拼出来的路径会变成 '/a.pdf'。 */
function moveInput(): PermissionRequestInput {
  return {
    taskId: TASK_ID,
    toolCallId: 'tc-move',
    capability: 'filesystem.move',
    bound: moveBound(`${posixRoot}/a.pdf`, `${posixRoot}/Reading/a.pdf`)
  }
}

describe('request：建记录、写事件、推送', () => {
  beforeEach(() => {
    openBroker()
  })

  it('落库的字段来自绑定结果，哈希与有效期都算对', async () => {
    const input = moveInput()
    const pending = broker!.request(input)

    // 落库、写事件、推送都在 request 返回挂起 promise 之前同步做完了，
    // 所以这里不用推进时间。用推进来结算反而会把它推成过期。
    const [record] = stored()
    expect(record).toMatchObject({
      id: 'perm-1',
      taskId: TASK_ID,
      toolCallId: 'tc-move',
      capability: 'filesystem.move',
      status: 'pending',
      requestedAt: T0,
      decidedAt: null,
      // move 的 source 是来源，target 是目标，不能都塞进 sourcePaths
      sourcePaths: [`${posixRoot}/a.pdf`],
      targetPath: `${posixRoot}/Reading/a.pdf`
    })
    expect(record.argsHash).toBe(fingerprintArguments(input.bound).hash)
    expect(record.argsCanonical).toBe(fingerprintArguments(input.bound).canonical)

    broker!.respond('perm-1', 'approved')
    await pending
  })

  it('create_dir 的 path 归到 targetPath，sourcePaths 为空', async () => {
    const pending = broker!.request({
      taskId: TASK_ID,
      toolCallId: 'tc-dir',
      capability: 'filesystem.create_dir',
      bound: dirBound(`${posixRoot}/Reading`)
    })

    expect(stored()[0]).toMatchObject({
      sourcePaths: [],
      targetPath: `${posixRoot}/Reading`
    })

    broker!.respond('perm-1', 'approved')
    await pending
  })

  it('不注入 ttlMs 时用 expiry.ts 的五分钟', async () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    new SqliteTaskRepository(d).insert({
      id: TASK_ID,
      goal: 'g',
      status: 'running',
      createdAt: T0,
      updatedAt: T0
    })
    broker = createPermissionBroker({
      permissions: new SqlitePermissionRepository(d),
      events: new SqliteEventRepository(d),
      now: () => clock,
      newId: () => `perm-${++idSeq}`,
      root: () => posixRoot
    })

    const pending = broker.request(moveInput())
    // 五分钟内不该过期
    vi.advanceTimersByTime(PERMISSION_TTL_MS - 1)
    expect(stored()[0].status).toBe('pending')
    expect(eventsOfType(PERMISSION_EVENT.EXPIRED)).toHaveLength(0)

    vi.advanceTimersByTime(1)
    await pending
    expect(eventsOfType(PERMISSION_EVENT.EXPIRED)).toHaveLength(1)
  })

  it('写一条 permission_requested 事件，payload 带面板要展示的七项素材', async () => {
    const pending = broker!.request(moveInput())

    const written = eventsOfType(PERMISSION_EVENT.REQUESTED)
    expect(written).toHaveLength(1)
    expect(written[0].taskId).toBe(TASK_ID)
    expect(written[0].occurredAt).toBe(T0)
    expect(written[0].payload).toEqual({
      permissionId: 'perm-1',
      capability: 'filesystem.move',
      sourcePaths: [`${posixRoot}/a.pdf`],
      targetPath: `${posixRoot}/Reading/a.pdf`,
      expiresAt: '2026-09-14T09:00:01.000Z'
    })

    broker!.respond('perm-1', 'approved')
    await pending
  })

  it('推一条 requested 通知，带完整记录', async () => {
    const pending = broker!.request(moveInput())

    expect(notices).toEqual([{ kind: 'requested', permission: stored()[0] }])

    broker!.respond('perm-1', 'approved')
    await pending
  })

  it('没注入 notify 时不报错，只落库', async () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    new SqliteTaskRepository(d).insert({
      id: TASK_ID,
      goal: 'g',
      status: 'running',
      createdAt: T0,
      updatedAt: T0
    })
    broker = createPermissionBroker({
      permissions: new SqlitePermissionRepository(d),
      events: new SqliteEventRepository(d),
      now: () => clock,
      newId: () => `perm-${++idSeq}`,
      ttlMs: 10,
      root: () => posixRoot
    })

    const pending = broker.request(moveInput())
    vi.advanceTimersByTime(10)
    const outcome = await pending
    expect(outcome.approved).toBe(false)
    expect(stored()).toHaveLength(1)
  })

  it('挂起不立即结算', () => {
    let settled = false
    void broker!.request(moveInput()).then(() => {
      settled = true
    })

    // 让微任务队列跑一轮。真结算的话这里就是 true 了
    return Promise.resolve().then(() => {
      expect(settled).toBe(false)
    })
  })
})

describe('respond', () => {
  beforeEach(() => {
    openBroker()
  })

  it('批准：写库、写事件、推送，并唤醒挂起', async () => {
    const waiting = broker!.request(moveInput())
    // 让 request 走完落库与推送
    await Promise.resolve()

    const result = broker!.respond('perm-1', 'approved')
    expect(result).toMatchObject({ ok: true, repeated: false })

    const outcome = await waiting
    expect(outcome).toEqual({ approved: true, permission: stored()[0] })
    expect(stored()[0]).toMatchObject({ status: 'approved', decidedAt: T0 })
    expect(eventsOfType(PERMISSION_EVENT.DECISION)).toHaveLength(1)
    expect(notices.at(-1)).toEqual({
      kind: 'resolved',
      permissionId: 'perm-1',
      state: 'approved'
    })
  })

  it('拒绝：唤醒时带 PERMISSION_DENIED，任务不被判死由调用方决定', async () => {
    const waiting = broker!.request(moveInput())
    await Promise.resolve()

    broker!.respond('perm-1', 'denied')

    const outcome = await waiting
    expect(outcome.approved).toBe(false)
    if (!outcome.approved) {
      expect(outcome.code).toBe(ERROR_CODE.PERMISSION_DENIED)
      expect(outcome.reason).toContain('filesystem.move')
    }
    expect(stored()[0].status).toBe('denied')
  })

  it('同结论重复响应无副作用：不再写事件、不再推送、repeated=true', async () => {
    const waiting = broker!.request(moveInput())
    await Promise.resolve()
    broker!.respond('perm-1', 'approved')
    await waiting

    const eventsBefore = events().length
    const noticesBefore = notices.length
    const decidedAtBefore = stored()[0].decidedAt

    clock = '2026-09-14T09:30:00.000Z'
    const again = broker!.respond('perm-1', 'approved')

    expect(again).toMatchObject({ ok: true, repeated: true })
    expect(events()).toHaveLength(eventsBefore)
    expect(notices).toHaveLength(noticesBefore)
    // decidedAt 也不能被第二次调用改写，否则审计时间就是错的
    expect(stored()[0].decidedAt).toBe(decidedAtBefore)
  })

  it('结论冲突时报错，且不产生任何副作用', async () => {
    const waiting = broker!.request(moveInput())
    await Promise.resolve()
    broker!.respond('perm-1', 'approved')
    await waiting

    const eventsBefore = events().length
    const conflict = broker!.respond('perm-1', 'denied')

    expect(conflict.ok).toBe(false)
    if (!conflict.ok) {
      expect(conflict.reason).toContain('approved')
      expect(conflict.reason).toContain('denied')
    }
    expect(events()).toHaveLength(eventsBefore)
    expect(stored()[0].status).toBe('approved')
  })

  it('不存在的 permissionId 回 PERMISSION_REQUIRED', () => {
    const result = broker!.respond('perm-404', 'approved')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_REQUIRED)
  })
})

describe('过期定时器', () => {
  beforeEach(() => {
    openBroker()
  })

  it('到点唤醒挂起，回 PERMISSION_EXPIRED', async () => {
    const outcome = await (async () => {
      const waiting = broker!.request(moveInput())
      vi.advanceTimersByTime(1000)
      return waiting
    })()

    expect(outcome.approved).toBe(false)
    if (!outcome.approved) {
      expect(outcome.code).toBe(ERROR_CODE.PERMISSION_EXPIRED)
      expect(outcome.reason).toContain('1 秒')
    }
  })

  it('到点写 permission_expired 事件并推送 expired', async () => {
    const waiting = broker!.request(moveInput())
    vi.advanceTimersByTime(1000)
    await waiting

    const expired = eventsOfType(PERMISSION_EVENT.EXPIRED)
    expect(expired).toHaveLength(1)
    expect(expired[0].payload).toEqual({
      permissionId: 'perm-1',
      expiresAt: '2026-09-14T09:00:01.000Z'
    })
    expect(notices.at(-1)).toEqual({
      kind: 'resolved',
      permissionId: 'perm-1',
      state: 'expired'
    })
  })

  it('过期不改库：status 停在 pending，decidedAt 仍是 null', async () => {
    const waiting = broker!.request(moveInput())
    vi.advanceTimersByTime(1000)
    await waiting

    // expired 是查询时的投影，不是库里的值。落库会让 status 的 CHECK 约束多一个值，
    // 而那个值随时会因为时钟变化而失效。
    expect(stored()[0]).toMatchObject({ status: 'pending', decidedAt: null })

    // 过期投影读的是注入的 now，不是 setTimeout 的时钟，两者不会自动同步。
    // 不拨 clock 的话这里会算成 pending，看上去就像投影没生效。
    clock = '2026-09-14T09:00:02.000Z'
    expect(broker!.listForTask(TASK_ID)).toEqual([{ permission: stored()[0], state: 'expired' }])
  })

  it('批准之后推进时间不再触发过期', async () => {
    const waiting = broker!.request(moveInput())
    await Promise.resolve()
    broker!.respond('perm-1', 'approved')
    await waiting

    vi.advanceTimersByTime(60_000)

    expect(eventsOfType(PERMISSION_EVENT.EXPIRED)).toHaveLength(0)
    expect(stored()[0].status).toBe('approved')
  })

  it('dispose 之后推进时间不写事件，挂起也不结算', async () => {
    let settled = false
    const waiting = broker!.request(moveInput())
    void waiting.then(() => {
      settled = true
    })
    await Promise.resolve()

    broker!.dispose()
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(eventsOfType(PERMISSION_EVENT.EXPIRED)).toHaveLength(0)
  })

  it('过期之后的迟到批准：回 PERMISSION_EXPIRED，不写库也不写事件', async () => {
    const waiting = broker!.request(moveInput())
    vi.advanceTimersByTime(1000)
    await waiting

    const result = broker!.respond('perm-1', 'approved')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_EXPIRED)
    // 写库会让记录声称「已批准」，而没有任何调用会被放行
    expect(stored()[0]).toMatchObject({ status: 'pending', decidedAt: null })
    expect(eventsOfType(PERMISSION_EVENT.DECISION)).toHaveLength(0)
  })

  it('dispose 之后的响应：回 PERMISSION_EXPIRED，不写库也不写事件', () => {
    const waiting = broker!.request(moveInput())
    void waiting

    broker!.dispose()
    const result = broker!.respond('perm-1', 'approved')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_EXPIRED)
    expect(stored()[0]).toMatchObject({ status: 'pending', decidedAt: null })
    expect(eventsOfType(PERMISSION_EVENT.DECISION)).toHaveLength(0)
  })
})

describe('verifyPermission：六步验证', () => {
  let realFile = ''
  let outsideDir = ''

  beforeEach(() => {
    openBroker()
    realFile = join(tmpRoot, 'a.pdf')
    writeFileSync(realFile, '%PDF-1.4\n', 'utf8')
    outsideDir = mkdtempSync(join(tmpdir(), 'pa-broker-outside-'))
  })

  afterEach(() => {
    rmSync(outsideDir, { recursive: true, force: true, maxRetries: 10 })
  })

  /** 走完整批准流程，拿到一条真实的 approved 记录 */
  async function approveReal(): Promise<PermissionRecord> {
    const waiting = broker!.request(moveInput())
    await Promise.resolve()
    broker!.respond('perm-1', 'approved')
    await waiting
    return stored()[0]
  }

  it('库里没有这条 → PERMISSION_REQUIRED，不是 TAMPERED', async () => {
    const result = await verifyPermission({
      permission: null,
      fingerprint: fingerprintArguments(moveInput().bound),
      toolCallId: 'tc-move',
      now: T0,
      root: posixRoot
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_REQUIRED)
  })

  it('status 是 denied → PERMISSION_DENIED', async () => {
    const permission = await approveReal()
    const result = await verifyPermission({
      permission: { ...permission, status: 'denied' },
      fingerprint: fingerprintArguments(moveInput().bound),
      toolCallId: 'tc-move',
      now: T0,
      root: posixRoot
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_DENIED)
  })

  it('已过有效期 → PERMISSION_EXPIRED', async () => {
    const permission = await approveReal()
    const result = await verifyPermission({
      permission,
      fingerprint: fingerprintArguments(moveInput().bound),
      toolCallId: 'tc-move',
      // expiresAt 是 09:00:01.000Z，这里给它一秒之后
      now: '2026-09-14T09:00:02.000Z',
      root: posixRoot
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_EXPIRED)
  })

  it('denied 的记录不参与过期投影，仍回 PERMISSION_DENIED', async () => {
    const permission = await approveReal()
    const result = await verifyPermission({
      permission: { ...permission, status: 'denied' },
      fingerprint: fingerprintArguments(moveInput().bound),
      toolCallId: 'tc-move',
      now: '2027-01-01T00:00:00.000Z',
      root: posixRoot
    })

    // 顺序在这里有意义：第 2 步先于第 3 步，所以 denied 压过 expired
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_DENIED)
  })

  it('toolCallId 对不上 → PERMISSION_TAMPERED', async () => {
    const permission = await approveReal()
    const result = await verifyPermission({
      permission,
      fingerprint: fingerprintArguments(moveInput().bound),
      toolCallId: 'tc-someone-else',
      now: T0,
      root: posixRoot
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_TAMPERED)
  })

  it('参数变了 → PERMISSION_TAMPERED（Checklist「参数变化后旧 Permission 无效」）', async () => {
    const permission = await approveReal()
    const tampered = moveBound(`${posixRoot}/a.pdf`, `${posixRoot}/Reading/other.pdf`)

    const result = await verifyPermission({
      permission,
      fingerprint: fingerprintArguments(tampered),
      toolCallId: 'tc-move',
      now: T0,
      root: posixRoot
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODE.PERMISSION_TAMPERED)
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  it('来源路径经 junction 逃出根 → 透传 guard 的码', async () => {
    const link = join(tmpRoot, 'leak-src')
    symlinkSync(outsideDir, link, 'junction')
    const permission = await approveReal()

    const result = await verifyPermission({
      permission: {
        ...permission,
        sourcePaths: [join(link, 'a.pdf').split(sep).join('/')],
        // 哈希要跟着改，否则第 5 步会先拦住，测不到第 6 步
        argsHash: fingerprintArguments(
          moveBound(join(link, 'a.pdf').split(sep).join('/'), permission.targetPath ?? '')
        ).hash
      },
      fingerprint: fingerprintArguments(
        moveBound(join(link, 'a.pdf').split(sep).join('/'), permission.targetPath ?? '')
      ),
      toolCallId: 'tc-move',
      now: T0,
      root: posixRoot
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PATH_ESCAPES_ROOT_VIA_LINK)
  })

  it('目标路径在根外 → 透传 PATH_OUT_OF_ROOT', async () => {
    const outsideTarget = join(outsideDir, 'a.pdf').split(sep).join('/')
    const permission = await approveReal()
    const bound = moveBound(`${posixRoot}/a.pdf`, outsideTarget)

    const result = await verifyPermission({
      permission: {
        ...permission,
        targetPath: outsideTarget,
        argsHash: fingerprintArguments(bound).hash
      },
      fingerprint: fingerprintArguments(bound),
      toolCallId: 'tc-move',
      now: T0,
      root: posixRoot
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })

  it('create_dir 没有来源路径，只复查 targetPath', async () => {
    const bound = dirBound(`${posixRoot}/Reading`)
    const waiting = broker!.request({
      taskId: TASK_ID,
      toolCallId: 'tc-dir',
      capability: 'filesystem.create_dir',
      bound
    })
    await Promise.resolve()
    broker!.respond('perm-1', 'approved')
    await waiting

    const result = await verifyPermission({
      permission: stored()[0],
      fingerprint: fingerprintArguments(bound),
      toolCallId: 'tc-dir',
      now: T0,
      root: posixRoot
    })

    expect(result).toEqual({ ok: true })
  })

  it('六步全过 → ok: true', async () => {
    const permission = await approveReal()
    const result = await verifyPermission({
      permission,
      fingerprint: fingerprintArguments(moveInput().bound),
      toolCallId: 'tc-move',
      now: T0,
      root: posixRoot
    })

    expect(result).toEqual({ ok: true })
  })
})

describe('broker.verify：组装入参', () => {
  beforeEach(() => {
    openBroker()
  })

  it('库里没这个 callId 时走第 1 步', async () => {
    const result = await broker!.verify('tc-never-asked', moveInput().bound)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_REQUIRED)
  })

  it('批准后用同样的参数验，通过', async () => {
    const waiting = broker!.request(moveInput())
    await Promise.resolve()
    broker!.respond('perm-1', 'approved')
    await waiting

    expect(await broker!.verify('tc-move', moveInput().bound)).toEqual({ ok: true })
  })

  it('批准后换了参数再验，被拦', async () => {
    const waiting = broker!.request(moveInput())
    await Promise.resolve()
    broker!.respond('perm-1', 'approved')
    await waiting

    const result = await broker!.verify(
      'tc-move',
      moveBound(`${posixRoot}/a.pdf`, `${posixRoot}/Reading/changed.pdf`)
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(ERROR_CODE.PERMISSION_TAMPERED)
  })

  it('mkdirSync 建出的真实目录不影响复查', async () => {
    mkdirSync(join(tmpRoot, 'Reading'), { recursive: true })
    const waiting = broker!.request(moveInput())
    await Promise.resolve()
    broker!.respond('perm-1', 'approved')
    await waiting

    expect(await broker!.verify('tc-move', moveInput().bound)).toEqual({ ok: true })
  })
})
