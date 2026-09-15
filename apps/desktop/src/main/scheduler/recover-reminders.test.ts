import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  type FireOutcome
} from './fire-reminder'
import { MAX_TIMEOUT_MS, ReminderTimerService, type TimerHandle } from './reminder-timer'
import {
  recoverReminders,
  type RecoveryOutcome,
  type RecoverRemindersDeps
} from './recover-reminders'

/**
 * 启动恢复的验收（TASK-025）：重启测试 10/10。
 *
 * 真内存库 + 假通知端口 + 假时钟：状态翻转、notification_sent 证据、timer
 * 重挂都跑在真 SQL 与真 ReminderTimerService 上，只有 OS 通知是替身。
 * 第 10 例是 PRD SC-04 的十轮「创建提醒 → 关闭应用 → 重启应用」循环。
 *
 * 判定表未落地前本文件全红——它就是恢复策略的验收标准。
 */

const T0 = '2026-09-15T09:00:00.000Z'
/** 启动时刻：整轮恢复与补发共用同一个 stamp。 */
const NOW = '2026-09-15T20:00:00.000Z'
const NOW_MS = Date.parse(NOW)
/** 已过期（错过）与未到点两种 remindAt。 */
const DUE = '2026-09-15T19:00:00.000Z'
const FUTURE = '2026-09-15T21:00:00.000Z'
const MESSAGE = '该阅读 report-2026.pdf 的摘要了'
/** 上一次进程真正发出通知的时刻（firing 残留事件里的 sentAt）。 */
const PREVIOUS_SENT_AT = '2026-09-15T19:00:03.000Z'
/** SC-04 循环里每轮提醒的提前量。 */
const CYCLE_LEAD_MS = 60_000

interface FakeTimerEntry {
  id: number
  fn: () => void
  dueAt: number
}

let db: SqliteDatabase
let reminders: SqliteReminderRepository
let events: SqliteEventRepository
let armed: ReminderRecord[]
let sentRequests: NotificationRequest[]
let portOutcome: NotificationOutcome
let clockMs: number
let fakeTimers: FakeTimerEntry[]
let nextTimerId: number
let errorSpy: ReturnType<typeof vi.spyOn>

const clockIso = (): string => new Date(clockMs).toISOString()

// 假 setTimer 模拟 Node 对溢出延迟「几乎立即触发」的行为，与
// reminder-timer.test.ts 同款：重挂链要真的按分段走，不是假时钟上的假正确。
const setTimer = (fn: () => void, ms: number): TimerHandle => {
  const effective = ms > MAX_TIMEOUT_MS ? 1 : Math.max(ms, 0)
  const entry: FakeTimerEntry = { id: nextTimerId++, fn, dueAt: clockMs + effective }
  fakeTimers.push(entry)
  return entry.id as unknown as TimerHandle
}

const clearTimer = (handle: TimerHandle): void => {
  const id = handle as unknown as number
  fakeTimers = fakeTimers.filter((t) => t.id !== id)
}

function advanceTo(target: number): void {
  for (;;) {
    const due = fakeTimers.filter((t) => t.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0]
    if (due === undefined) break
    clockMs = due.dueAt
    fakeTimers = fakeTimers.filter((t) => t.id !== due.id)
    due.fn()
  }
  clockMs = target
}

/** 让 timer 里 void fire(...).then 的链跑完。 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const fakePort: NotificationPort = {
  send: async (request) => {
    sentRequests.push(request)
    return portOutcome
  }
}

/** 生产口径的补发动作：真 fireReminder + 真库，只有通知端口是替身。 */
function fireWithClock(reminder: ReminderRecord): Promise<FireOutcome> {
  return fireReminder(reminder, {
    db,
    reminders,
    events,
    notifications: fakePort,
    now: clockIso
  })
}

function makeTimerService(): ReminderTimerService {
  return new ReminderTimerService({ fire: fireWithClock, now: () => clockMs, setTimer, clearTimer })
}

function makeDeps(overrides: Partial<RecoverRemindersDeps> = {}): RecoverRemindersDeps {
  return {
    reminders,
    events,
    arm: (reminder) => {
      armed.push(reminder)
    },
    fire: fireWithClock,
    now: clockIso,
    ...overrides
  }
}

function seedTask(taskId: string): void {
  new SqliteTaskRepository(db).insert({
    id: taskId,
    goal: `目标 ${taskId}`,
    status: 'running',
    createdAt: T0,
    updatedAt: T0
  })
}

/** 直接落库成指定状态：模拟「崩在那一刻」的存量记录，不重放状态机。 */
function seedReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  const record: ReminderRecord = {
    id: 'r-1',
    taskId: 't-1',
    toolCallId: 'tc-r-1',
    remindAt: DUE,
    message: MESSAGE,
    idempotencyKey: 'scheduler.create:hash-r-1',
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

function appendSentEvent(taskId: string, reminderId: string, sentAt: string): void {
  events.append({
    taskId,
    type: NOTIFICATION_SENT_EVENT,
    payload: { reminderId, sentAt },
    occurredAt: sentAt
  })
}

/** 只看某一条的结局：多轮循环时表里还躺着别的 Reminder。 */
function outcomesOf(
  outcomes: readonly RecoveryOutcome[],
  reminderId: string
): readonly RecoveryOutcome[] {
  return outcomes.filter((outcome) => outcome.reminderId === reminderId)
}

beforeEach(() => {
  db = openProductState(MEMORY_DB)
  migrate(db)
  seedTask('t-1')
  reminders = new SqliteReminderRepository(db)
  events = new SqliteEventRepository(db)
  armed = []
  sentRequests = []
  portOutcome = { ok: true }
  clockMs = NOW_MS
  fakeTimers = []
  nextTimerId = 1
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  db.close()
})

describe('启动恢复：重启测试 10/10', () => {
  it('1. scheduled + 未来 → 重挂 timer 等它到点，启动不发通知', async () => {
    const record = seedReminder({ remindAt: FUTURE })

    const outcomes = await recoverReminders(makeDeps())

    expect(outcomes).toEqual([{ kind: 'rearmed', reminderId: 'r-1' }])
    expect(armed.map((r) => r.id)).toEqual(['r-1'])
    expect(armed[0].remindAt).toBe(FUTURE)
    expect(sentRequests).toHaveLength(0)
    // 重挂不动记录：库内逐字段原样
    expect(reminders.findById('r-1')).toEqual(record)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('2. scheduled + 已过期（错过的提醒）→ 启动补发一次，随后 fired', async () => {
    seedReminder({ remindAt: DUE })

    const outcomes = await recoverReminders(makeDeps())

    expect(outcomes).toEqual([{ kind: 'fired_missed', reminderId: 'r-1' }])
    expect(sentRequests).toEqual([{ title: NOTIFICATION_TITLE, body: MESSAGE }])
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('fired')
    expect(row?.firedAt).toBe(NOW)
    expect(events.listByTask('t-1').map((e) => e.type)).toEqual([NOTIFICATION_SENT_EVENT])
    // 补发过的绝不挂表：挂上等于到点再发一次
    expect(armed).toHaveLength(0)
  })

  it('3. firing + 有 notification_sent → 只补记 fired，绝不重发', async () => {
    seedReminder({ status: 'firing', remindAt: DUE })
    appendSentEvent('t-1', 'r-1', PREVIOUS_SENT_AT)

    const outcomes = await recoverReminders(makeDeps())

    expect(outcomes).toEqual([{ kind: 'completed', reminderId: 'r-1' }])
    expect(sentRequests).toHaveLength(0)
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('fired')
    // firedAt 取事件里的发送时刻（那次真的发了），不是启动时刻
    expect(row?.firedAt).toBe(PREVIOUS_SENT_AT)
    // 证据只有原来那条：恢复不追加事件、不改写历史
    expect(events.listByTask('t-1')).toHaveLength(1)
    expect(armed).toHaveLength(0)
  })

  it('4. firing + 无发送证据 + 未到点 → 回滚 scheduled 并重挂（不补发）', async () => {
    // 时钟回拨或记录异常时才会出现的组合；防御性分支，但方向必须是「回滚后重挂」。
    seedReminder({ status: 'firing', remindAt: FUTURE })

    const outcomes = await recoverReminders(makeDeps())

    expect(outcomes).toEqual([{ kind: 'rearmed', reminderId: 'r-1' }])
    expect(sentRequests).toHaveLength(0)
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('scheduled')
    expect(row?.updatedAt).toBe(NOW)
    expect(armed.map((r) => r.id)).toEqual(['r-1'])
  })

  it('5. firing + 无发送证据 + 已过期 → 回滚后补发一次，随后 fired', async () => {
    // 结果未知不敢算发过：回滚 scheduled 再按过期分流，补发的是「错过的提醒」。
    seedReminder({ status: 'firing', remindAt: DUE })

    const outcomes = await recoverReminders(makeDeps())

    expect(outcomes).toEqual([{ kind: 'fired_missed', reminderId: 'r-1' }])
    expect(sentRequests).toHaveLength(1)
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('fired')
    expect(row?.firedAt).toBe(NOW)
    expect(armed).toHaveLength(0)
  })

  it('6. fired 终态 → 永不重发也不重挂', async () => {
    const record = seedReminder({ status: 'fired', remindAt: DUE, firedAt: PREVIOUS_SENT_AT })

    const outcomes = await recoverReminders(makeDeps())

    expect(outcomes).toEqual([{ kind: 'skipped', reminderId: 'r-1', reason: 'fired' }])
    expect(sentRequests).toHaveLength(0)
    expect(armed).toHaveLength(0)
    expect(reminders.findById('r-1')).toEqual(record)
  })

  it('7. failed → 保留失败原因，恢复不自动重试（只允许显式重试）', async () => {
    const record = seedReminder({
      status: 'failed',
      remindAt: DUE,
      failureReason: 'Windows 通知通道不可用'
    })

    const outcomes = await recoverReminders(makeDeps())

    expect(outcomes).toEqual([{ kind: 'skipped', reminderId: 'r-1', reason: 'failed' }])
    expect(sentRequests).toHaveLength(0)
    expect(armed).toHaveLength(0)
    expect(reminders.findById('r-1')).toEqual(record)
  })

  it('8. 重复启动：一条错过提醒连跑 10 轮恢复，通知恰好一次', async () => {
    seedReminder({ remindAt: DUE })

    const outcomes: RecoveryOutcome[] = []
    for (let round = 0; round < 10; round++) {
      outcomes.push(...(await recoverReminders(makeDeps())))
    }

    expect(sentRequests).toHaveLength(1)
    expect(outcomes[0]).toEqual({ kind: 'fired_missed', reminderId: 'r-1' })
    // 其余九轮都是「已 fired」的 skip：既不重发也不重挂
    expect(outcomes.slice(1)).toEqual(
      Array.from({ length: 9 }, () => ({ kind: 'skipped', reminderId: 'r-1', reason: 'fired' }))
    )
    expect(reminders.findById('r-1')?.firedAt).toBe(NOW)
  })

  it('9. 补发失败 → failed + 原因 + notification_failed 事件；下轮恢复不自动重试', async () => {
    portOutcome = { ok: false, reason: 'Windows 通知通道不可用' }
    seedReminder({ remindAt: DUE })

    const first = await recoverReminders(makeDeps())

    expect(first).toEqual([
      { kind: 'send_failed', reminderId: 'r-1', reason: 'Windows 通知通道不可用' }
    ])
    expect(sentRequests).toHaveLength(1)
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('failed')
    expect(row?.failureReason).toBe('Windows 通知通道不可用')
    expect(row?.firedAt).toBeNull()
    expect(events.listByTask('t-1').map((e) => e.type)).toEqual([NOTIFICATION_FAILED_EVENT])

    // 重启再来一次：failed 保留原因等显式重试，恢复不碰
    const second = await recoverReminders(makeDeps())
    expect(second).toEqual([{ kind: 'skipped', reminderId: 'r-1', reason: 'failed' }])
    expect(sentRequests).toHaveLength(1)
  })

  it('10. SC-04：10 次「创建提醒 → 关闭 → 重启」循环，全部保留、按时触发、每条最多一次', async () => {
    let timer = makeTimerService()

    for (let cycle = 0; cycle < 10; cycle++) {
      const taskId = `t-c${cycle}`
      const reminderId = `r-c${cycle}`
      // ── 进程内：创建一条 Reminder（这里等价于 scheduler.create 落库）──
      seedTask(taskId)
      const remindAt = new Date(clockMs + CYCLE_LEAD_MS).toISOString()
      seedReminder({ id: reminderId, taskId, remindAt, toolCallId: `tc-${reminderId}` })

      // ── 关闭应用：进程内 timer 随进程消失 ──
      timer.dispose()

      // ── 重启：新 timer 服务 + 启动恢复 ──
      timer = makeTimerService()
      const afterRestart = await recoverReminders(makeDeps({ arm: (r) => timer.arm(r) }))
      expect(outcomesOf(afterRestart, reminderId)).toEqual([{ kind: 'rearmed', reminderId }])
      // 提醒必须保留
      expect(reminders.findById(reminderId)?.status).toBe('scheduled')

      // 再重启一次（重复启动）：不重复挂表、不提前发
      await recoverReminders(makeDeps({ arm: (r) => timer.arm(r) }))
      expect(sentRequests).toHaveLength(cycle)

      // ─ 到点：按时触发，恰好一次 ─
      advanceTo(clockMs + CYCLE_LEAD_MS)
      await flushAsync()
      expect(reminders.findById(reminderId)?.status).toBe('fired')
      expect(sentRequests).toHaveLength(cycle + 1)

      // ── 触发后再重启：终态，绝不重发 ──
      timer.dispose()
      const afterFire = await recoverReminders(makeDeps({ arm: (r) => timer.arm(r) }))
      expect(outcomesOf(afterFire, reminderId)).toEqual([
        { kind: 'skipped', reminderId, reason: 'fired' }
      ])
      expect(sentRequests).toHaveLength(cycle + 1)
    }

    // 十轮十发：每轮一条、每轮恰好一次
    expect(sentRequests).toHaveLength(10)
    expect(sentRequests.map((r) => r.body)).toEqual(Array.from({ length: 10 }, () => MESSAGE))
  })
})
