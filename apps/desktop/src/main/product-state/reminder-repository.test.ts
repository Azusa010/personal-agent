import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { SqliteTaskRepository } from './task-repository'
import {
  SqliteReminderRepository,
  IllegalReminderTransition,
  ReminderAlreadyExists,
  ALLOWED_TRANSITIONS,
  assertTransitionAllowed,
  isReminderStatus,
  REMINDER_STATUSES,
  type ReminderRecord
} from './reminder-repository'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

const T0 = '2026-09-15T09:00:00.000Z'
const T1 = '2026-09-15T09:00:05.000Z'
const REMIND_AT = '2026-09-15T20:00:00.000Z'

function seedTask(d: SqliteDatabase, id = 't-1'): void {
  new SqliteTaskRepository(d).insert({
    id,
    goal: `目标 ${id}`,
    status: 'running',
    createdAt: T0,
    updatedAt: T0
  })
}

/** task_id UNIQUE：一条 Reminder 一个任务。seedTasks 默认给足四个任务，
 *  CHECK 防漂移测试要按状态数组逐个落库。 */
function makeRepo(taskIds = ['t-1', 't-2', 't-3', 't-4']): SqliteReminderRepository {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  for (const id of taskIds) seedTask(d, id)
  return new SqliteReminderRepository(d)
}

function reminder(id: string, overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id,
    taskId: 't-1',
    toolCallId: `call-${id}`,
    remindAt: REMIND_AT,
    message: '该阅读 report-2026.pdf 的摘要了',
    idempotencyKey: `scheduler.create:hash-${id}`,
    status: 'scheduled',
    createdAt: T0,
    updatedAt: T0,
    firedAt: null,
    failureReason: null,
    ...overrides
  }
}

describe('reminders 表结构', () => {
  it('migration 建出 11 列，列名与 DDL 逐字对应', () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    const columns = d.prepare(`PRAGMA table_info(reminders)`).all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'task_id',
      'tool_call_id',
      'remind_at',
      'message',
      'idempotency_key',
      'status',
      'created_at',
      'updated_at',
      'fired_at',
      'failure_reason'
    ])
  })

  it('status 非法值被 CHECK 拦（填齐 NOT NULL 列，确保拦的是 CHECK 不是 NOT NULL）', () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    seedTask(d)
    expect(() =>
      d
        .prepare(
          `INSERT INTO reminders (id, task_id, tool_call_id, remind_at, message,
            idempotency_key, status, created_at, updated_at)
           VALUES ('r-1','t-1','c',?,'m','k','expired',?,?)`
        )
        .run(REMIND_AT, T0, T0)
    ).toThrow(/CHECK/)
  })

  it('REMINDER_STATUSES 每个成员都能落库，与 SQL CHECK 同源（防双源漂移）', () => {
    const repo = makeRepo()
    REMINDER_STATUSES.forEach((status, i) => {
      // task_id UNIQUE：每个状态用独立任务落库
      repo.insert(reminder(`r-${i}`, { taskId: `t-${i + 1}`, status }))
      expect(repo.findById(`r-${i}`)?.status).toBe(status)
    })
  })

  it('task_id UNIQUE 是数据库级约束：绕过 repository 直接 INSERT 第二条也拦', () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    seedTask(d)
    const insert = d.prepare(
      `INSERT INTO reminders (id, task_id, tool_call_id, remind_at, message,
        idempotency_key, status, created_at, updated_at)
       VALUES (?, 't-1', 'c', ?, 'm', ?, 'scheduled', ?, ?)`
    )
    insert.run('r-1', REMIND_AT, 'k-1', T0, T0)
    expect(() => insert.run('r-2', REMIND_AT, 'k-2', T0, T0)).toThrow(/UNIQUE/)
  })
})

describe('SqliteReminderRepository 读写往返', () => {
  it('insert 后 findById 读回，十一个字段一个不差', () => {
    const repo = makeRepo()
    const original = reminder('r-1')
    repo.insert(original)
    expect(repo.findById('r-1')).toEqual(original)
  })

  it('firedAt / failureReason 为 null 也能往返', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    const found = repo.findById('r-1')
    expect(found?.firedAt).toBeNull()
    expect(found?.failureReason).toBeNull()
  })

  it('findById 不命中返回 null', () => {
    const repo = makeRepo()
    expect(repo.findById('不存在')).toBeNull()
  })

  it('findByTaskId 命中该任务的唯一一条，别的任务不串', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1', { taskId: 't-1' }))
    repo.insert(reminder('r-2', { taskId: 't-2' }))
    expect(repo.findByTaskId('t-1')?.id).toBe('r-1')
    expect(repo.findByTaskId('t-2')?.id).toBe('r-2')
    expect(repo.findByTaskId('t-3')).toBeNull()
  })

  it('同一 Task 第二条 insert 抛 ReminderAlreadyExists，库里仍只有一条', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    expect(() => repo.insert(reminder('r-2'))).toThrow(ReminderAlreadyExists)
    expect(repo.findByTaskId('t-1')?.id).toBe('r-1')
  })

  it('ReminderAlreadyExists 带 taskId 与已有记录 id，executor 靠它拼稳定错误', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    try {
      repo.insert(reminder('r-2'))
      expect.unreachable('insert 应该抛 ReminderAlreadyExists')
    } catch (e) {
      expect(e).toBeInstanceOf(ReminderAlreadyExists)
      expect((e as ReminderAlreadyExists).taskId).toBe('t-1')
      expect((e as ReminderAlreadyExists).existingId).toBe('r-1')
    }
  })
})

describe('SqliteReminderRepository 状态翻转', () => {
  it('transition scheduled→firing→fired：firedAt 真落库', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    const firing = repo.transition('r-1', 'firing', T1)
    expect(firing.status).toBe('firing')
    expect(firing.updatedAt).toBe(T1)

    const fired = repo.transition('r-1', 'fired', T1, { firedAt: T1 })
    expect(fired.status).toBe('fired')
    expect(fired.firedAt).toBe(T1)
    // 从库里重新读回，确认真的落库而不是只改了返回对象
    const reloaded = repo.findById('r-1')
    expect(reloaded?.status).toBe('fired')
    expect(reloaded?.firedAt).toBe(T1)
  })

  it('transition firing→failed：failureReason 落库', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    repo.transition('r-1', 'firing', T1)
    const failed = repo.transition('r-1', 'failed', T1, { failureReason: '通知发送失败' })
    expect(failed.status).toBe('failed')
    expect(failed.failureReason).toBe('通知发送失败')
    expect(repo.findById('r-1')?.failureReason).toBe('通知发送失败')
  })

  it('transition failed→firing：显式重试合法，旧 failureReason 保留到新结论', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    repo.transition('r-1', 'firing', T1)
    repo.transition('r-1', 'failed', T1, { failureReason: '第一次失败' })
    const retried = repo.transition('r-1', 'firing', T1)
    expect(retried.status).toBe('firing')
    expect(retried.failureReason).toBe('第一次失败')
  })

  it('transition firing→scheduled：启动恢复重挂合法（TASK-025 用）', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    repo.transition('r-1', 'firing', T1)
    expect(repo.transition('r-1', 'scheduled', T1).status).toBe('scheduled')
  })

  it('transition fired→任意状态抛 IllegalReminderTransition，库里状态不变', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    repo.transition('r-1', 'firing', T1)
    repo.transition('r-1', 'fired', T1, { firedAt: T1 })
    expect(() => repo.transition('r-1', 'firing', T1)).toThrow(IllegalReminderTransition)
    expect(repo.findById('r-1')?.status).toBe('fired')
  })

  it('transition scheduled→fired 跳级抛：触发必须经过 firing', () => {
    const repo = makeRepo()
    repo.insert(reminder('r-1'))
    expect(() => repo.transition('r-1', 'fired', T1, { firedAt: T1 })).toThrow(
      IllegalReminderTransition
    )
  })

  it('transition 不存在的 id 抛', () => {
    const repo = makeRepo()
    expect(() => repo.transition('不存在', 'firing', T1)).toThrow(/不存在 id=不存在/)
  })
})

describe('状态机一致性', () => {
  it('assertTransitionAllowed 与 ALLOWED_TRANSITIONS 表逐格一致', () => {
    for (const from of REMINDER_STATUSES) {
      for (const to of REMINDER_STATUSES) {
        const allowed = ALLOWED_TRANSITIONS[from].includes(to)
        if (allowed) {
          expect(() => assertTransitionAllowed(from, to)).not.toThrow()
        } else {
          expect(() => assertTransitionAllowed(from, to)).toThrow(IllegalReminderTransition)
        }
      }
    }
  })

  it('fired 是终态：永不再次发送（恢复策略的铁律）', () => {
    expect(ALLOWED_TRANSITIONS['fired']).toEqual([])
  })

  it('failed 只允许显式重试进 firing，不允许直接翻 fired 伪造成功', () => {
    expect(ALLOWED_TRANSITIONS['failed']).toEqual(['firing'])
  })
})

describe('isReminderStatus', () => {
  it('四态都认，其它不认', () => {
    expect(isReminderStatus('scheduled')).toBe(true)
    expect(isReminderStatus('firing')).toBe(true)
    expect(isReminderStatus('fired')).toBe(true)
    expect(isReminderStatus('failed')).toBe(true)
    expect(isReminderStatus('expired')).toBe(false)
    expect(isReminderStatus('')).toBe(false)
  })
})
