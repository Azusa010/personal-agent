import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ERROR_CODE } from '@personal-agent/protocol'

import type { ReminderRecord } from '../../shared/domain'
import type {
  NotificationOutcome,
  NotificationPort,
  NotificationRequest
} from '../notifications/notification-port'
import {
  MEMORY_DB,
  migrate,
  openProductState,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import {
  fireReminder,
  NOTIFICATION_FAILED_EVENT,
  NOTIFICATION_SENT_EVENT,
  NOTIFICATION_TITLE,
  type FireReminderDeps
} from './fire-reminder'

/**
 * fireReminder 的验收（TASK-024）：到时发送一次并记录结果。
 *
 * 真内存库（better-sqlite3 :memory: + 全量 migration）+ 假通知端口：
 * 状态翻转、事件落库、同事务语义都在真 SQL 上钉，只有 OS 交互是替身。
 * TODO(你填) 完成前本文件红——它就是 fireReminder 的验收标准。
 */

const T0 = '2026-09-15T09:00:00.000Z'
/** 注入的「现在」。到点判定与所有 stamp 都用它。 */
const NOW = '2026-09-15T20:00:00.500Z'
/** 已到点的 remindAt（早于 NOW）。 */
const DUE = '2026-09-15T20:00:00.000Z'
/** 未到点的 remindAt（晚于 NOW）。 */
const FUTURE = '2026-09-15T21:00:00.000Z'
const MESSAGE = '该阅读 report-2026.pdf 的摘要了'

let db: SqliteDatabase
let reminders: SqliteReminderRepository
let events: SqliteEventRepository
let sentRequests: NotificationRequest[]
let portCalls: number
let portOutcome: NotificationOutcome
let portThrows: Error | null

const fakePort: NotificationPort = {
  send: async (req) => {
    portCalls += 1
    sentRequests.push(req)
    if (portThrows !== null) throw portThrows
    return portOutcome
  }
}

function makeDeps(): FireReminderDeps {
  return { db, reminders, events, notifications: fakePort, now: () => NOW }
}

function seedReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  const record: ReminderRecord = {
    id: 'r-1',
    taskId: 't-1',
    toolCallId: 'tc-1',
    remindAt: DUE,
    message: MESSAGE,
    idempotencyKey: 'scheduler.create:hash-r1',
    status: 'scheduled',
    createdAt: T0,
    updatedAt: T0,
    firedAt: null,
    failureReason: null,
    ...overrides
  }
  reminders.insert(record)
  return record
}

beforeEach(() => {
  db = openProductState(MEMORY_DB)
  migrate(db)
  new SqliteTaskRepository(db).insert({
    id: 't-1',
    goal: '目标 t-1',
    status: 'running',
    createdAt: T0,
    updatedAt: T0
  })
  reminders = new SqliteReminderRepository(db)
  events = new SqliteEventRepository(db)
  sentRequests = []
  portCalls = 0
  portOutcome = { ok: true }
  portThrows = null
})

afterEach(() => {
  db.close()
})

describe('fireReminder：到时发送一次', () => {
  it('scheduled + 到点 → 发送一次，翻 fired，notification_sent 同 stamp 落库', async () => {
    seedReminder()

    const outcome = await fireReminder(reminders.findById('r-1')!, makeDeps())

    expect(outcome).toEqual({ kind: 'sent', sentAt: NOW })
    // 端口收到的标题是常量、正文是落库的 message——不是任何调用方现编的
    expect(portCalls).toBe(1)
    expect(sentRequests[0]).toEqual({ title: NOTIFICATION_TITLE, body: MESSAGE })

    // 记录结果：fired + firedAt，整个触发用同一个 stamp
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('fired')
    expect(row?.firedAt).toBe(NOW)
    expect(row?.failureReason).toBeNull()

    // 事件：notification_sent 落了（TASK-025 的启动恢复靠它判定 firing 残留），
    // 没有失败事件
    const taskEvents = events.listByTask('t-1')
    const sent = taskEvents.find((e) => e.type === NOTIFICATION_SENT_EVENT)
    expect(sent).toBeDefined()
    expect(sent?.occurredAt).toBe(NOW)
    expect(sent?.payload).toMatchObject({ reminderId: 'r-1', sentAt: NOW })
    expect(taskEvents.some((e) => e.type === NOTIFICATION_FAILED_EVENT)).toBe(false)
  })

  it('同一条 Reminder 再触发 → already_sent，端口绝不第二次被碰', async () => {
    seedReminder()
    await fireReminder(reminders.findById('r-1')!, makeDeps())
    expect(portCalls).toBe(1)

    const second = await fireReminder(reminders.findById('r-1')!, makeDeps())

    // 「同一 Reminder 最多通知一次」：fired 是终态，重复触发幂等返回
    expect(second).toEqual({ kind: 'already_sent', sentAt: NOW })
    expect(portCalls).toBe(1)
    expect(events.listByTask('t-1').filter((e) => e.type === NOTIFICATION_SENT_EVENT)).toHaveLength(
      1
    )
  })

  it('落库 fired 的记录直接触发 → already_sent，原 firedAt 原样带回', async () => {
    // 重启后 TASK-025 恢复扫描、或 executor 幂等命中，都会走到这条路。
    seedReminder({ status: 'fired', firedAt: DUE, updatedAt: DUE })

    const outcome = await fireReminder(reminders.findById('r-1')!, makeDeps())

    expect(outcome).toEqual({ kind: 'already_sent', sentAt: DUE })
    expect(portCalls).toBe(0)
  })
})

describe('fireReminder：未到点与不可触发状态', () => {
  it('未到点 → rejected REMINDER_NOT_DUE，不碰端口不写库', async () => {
    seedReminder({ remindAt: FUTURE })

    const outcome = await fireReminder(reminders.findById('r-1')!, makeDeps())

    expect(outcome).toEqual({
      kind: 'rejected',
      code: ERROR_CODE.REMINDER_NOT_DUE,
      reason: expect.stringContaining(FUTURE)
    })
    expect(portCalls).toBe(0)
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('scheduled')
    expect(row?.updatedAt).toBe(T0)
    expect(events.listByTask('t-1')).toHaveLength(0)
  })

  it('firing（结果未知）→ rejected，绝不重发', async () => {
    // firing 是「触发中、通知结果未知」：再触发一次就可能双发。
    // 转换表本来也禁止 firing→firing，这里钉的是 fireReminder 把它收成
    // rejected 而不是让 IllegalReminderTransition 穿出去。
    seedReminder()
    reminders.transition('r-1', 'firing', NOW)

    const outcome = await fireReminder(reminders.findById('r-1')!, makeDeps())

    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.code).toBe(ERROR_CODE.REMINDER_NOT_DUE)
    }
    expect(portCalls).toBe(0)
  })

  it('failed + 到点 → 显式重试入口：重新发送并翻 fired', async () => {
    // 转换表 failed→firing 注释：「显式重试的唯一入口」。
    seedReminder()
    reminders.transition('r-1', 'firing', T0)
    reminders.transition('r-1', 'failed', T0, { failureReason: '上次通道忙' })

    const outcome = await fireReminder(reminders.findById('r-1')!, makeDeps())

    expect(outcome).toEqual({ kind: 'sent', sentAt: NOW })
    expect(portCalls).toBe(1)
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('fired')
    expect(row?.firedAt).toBe(NOW)
  })
})

describe('fireReminder：失败记录，不伪造成功', () => {
  it('端口报失败 → send_failed，翻 failed + failure_reason + notification_failed 事件', async () => {
    portOutcome = { ok: false, reason: 'Windows 通知通道不可用' }
    seedReminder()

    const outcome = await fireReminder(reminders.findById('r-1')!, makeDeps())

    expect(outcome).toEqual({ kind: 'send_failed', reason: 'Windows 通知通道不可用' })
    expect(portCalls).toBe(1)

    const row = reminders.findById('r-1')
    expect(row?.status).toBe('failed')
    expect(row?.failureReason).toContain('Windows 通知通道不可用')
    expect(row?.firedAt).toBeNull()

    const taskEvents = events.listByTask('t-1')
    const failed = taskEvents.find((e) => e.type === NOTIFICATION_FAILED_EVENT)
    expect(failed).toBeDefined()
    expect(failed?.payload).toMatchObject({ reminderId: 'r-1', reason: 'Windows 通知通道不可用' })
    expect(taskEvents.some((e) => e.type === NOTIFICATION_SENT_EVENT)).toBe(false)
  })

  it('端口意外 reject（适配器写坏了）→ 视同失败收进 send_failed，不 throw', async () => {
    // fireReminder 的调用方是 setTimeout 回调和 executor：throw 出去只会变成
    // unhandled rejection / HOST_HANDLER_FAILED，精确原因全丢。
    portThrows = new Error('适配器炸了')
    seedReminder()

    const outcome = await fireReminder(reminders.findById('r-1')!, makeDeps())

    expect(outcome.kind).toBe('send_failed')
    if (outcome.kind === 'send_failed') {
      expect(outcome.reason).toContain('适配器炸了')
    }
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('failed')
    expect(row?.failureReason).toContain('适配器炸了')
  })

  it('失败后再触发（未到重试条件时）不自动重发', async () => {
    // failed 只允许显式重试：同一 fireReminder 入口在未到点时同样拒绝。
    portOutcome = { ok: false, reason: '通道忙' }
    seedReminder({ remindAt: FUTURE })
    // 手动构出 failed 态（模拟上次到点失败后时间仍在未来是不可能的，
    // 这里直接落状态钉「failed + 未到点」的组合行为）
    reminders.transition('r-1', 'firing', T0)
    reminders.transition('r-1', 'failed', T0, { failureReason: '通道忙' })

    const outcome = await fireReminder(reminders.findById('r-1')!, makeDeps())

    expect(outcome.kind).toBe('rejected')
    expect(portCalls).toBe(0)
  })
})
