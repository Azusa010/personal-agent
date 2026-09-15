import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReminderRecord } from '../../shared/domain'
import type { FireOutcome } from './fire-reminder'
import { MAX_TIMEOUT_MS, ReminderTimerService, type TimerHandle } from './reminder-timer'

/**
 * ReminderTimerService 的验收（TASK-024）：到点恰好触发一次。
 *
 * 时钟与 setTimeout 全部注入。关键细节：假 setTimer **模拟 Node 的溢出
 * 行为**——延迟超过 2^31-1 ms 时按「几乎立即触发」处理（真 Node 会把溢出
 * 延迟当 1ms 并打 TimeoutOverflowWarning）。不模拟的话，「直接
 * setTimeout(超大延迟)」的错误实现也会在假时钟上表现正确，长延迟分段
 * 重挂的要求就钉不住了。
 *
 * schedule 落地前，本文件延迟相关用例红。
 */

interface FakeTimerEntry {
  id: number
  fn: () => void
  dueAt: number
}

const T0 = '2026-09-15T09:00:00.000Z'

let clockMs: number
let fakeTimers: FakeTimerEntry[]
let nextTimerId: number
let fired: ReminderRecord[]
let fireOutcome: FireOutcome
let fireThrows: Error | null

const setTimer = (fn: () => void, ms: number): TimerHandle => {
  // 模拟 Node：溢出延迟 ≈ 立即触发；负延迟按 0。
  const effective = ms > MAX_TIMEOUT_MS ? 1 : Math.max(ms, 0)
  const entry: FakeTimerEntry = { id: nextTimerId++, fn, dueAt: clockMs + effective }
  fakeTimers.push(entry)
  return entry.id as unknown as TimerHandle
}

const clearTimer = (handle: TimerHandle): void => {
  const id = handle as unknown as number
  fakeTimers = fakeTimers.filter((t) => t.id !== id)
}

/** 把时钟拨到 target，途中到点的 timer 按 dueAt 升序逐个触发（支持分段重挂链）。 */
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

/** 让 onDue 里 void fire(...).then 的链跑完。 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeService(fire?: (r: ReminderRecord) => Promise<FireOutcome>): ReminderTimerService {
  return new ReminderTimerService({
    fire:
      fire ??
      (async (r) => {
        fired.push(r)
        if (fireThrows !== null) throw fireThrows
        return fireOutcome
      }),
    now: () => clockMs,
    setTimer,
    clearTimer
  })
}

function makeRecord(id: string, remindAtOffsetMs: number): ReminderRecord {
  return {
    id,
    taskId: 't-1',
    toolCallId: `tc-${id}`,
    remindAt: new Date(clockMs + remindAtOffsetMs).toISOString(),
    message: `提醒 ${id}`,
    idempotencyKey: `scheduler.create:hash-${id}`,
    status: 'scheduled',
    createdAt: T0,
    updatedAt: T0,
    firedAt: null,
    failureReason: null
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  clockMs = 1_789_000_000_000
  fakeTimers = []
  nextTimerId = 1
  fired = []
  fireOutcome = { kind: 'sent', sentAt: new Date(clockMs).toISOString() }
  fireThrows = null
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

describe('ReminderTimerService：到点触发', () => {
  it('到点前不触发，到点恰好触发一次，之后不再触发', async () => {
    const service = makeService()
    const record = makeRecord('r-1', 5_000)
    service.arm(record)
    expect(service.isArmed('r-1')).toBe(true)

    advanceTo(clockMs + 4_999)
    await flushAsync()
    expect(fired).toHaveLength(0)
    expect(service.isArmed('r-1')).toBe(true)

    const dueAt = clockMs + 5_000
    advanceTo(dueAt)
    await flushAsync()
    expect(fired).toHaveLength(1)
    expect(fired[0]).toBe(record)
    // 触发过的表必须摘掉：isArmed 为 false，再拨时钟也不会二次触发
    expect(service.isArmed('r-1')).toBe(false)

    advanceTo(dueAt + 100_000)
    await flushAsync()
    expect(fired).toHaveLength(1)
  })

  it('arm 时已过点 → 0 延迟，立即触发', async () => {
    // 过点补发语义是 TASK-025 的事；timer 层只钉「负延迟不变成永不触发」。
    const service = makeService()
    service.arm(makeRecord('r-late', -1_000))

    advanceTo(clockMs)
    await flushAsync()
    expect(fired).toHaveLength(1)
  })

  it('超长延迟（> 2^31-1）分段重挂：绝不提前触发', async () => {
    // 「下个月提醒我」：直接 setTimeout(超大延迟) 会被 Node 当溢出**立即**
    // 触发（假 setTimer 模拟了这个行为）。正确实现必须分段。
    const service = makeService()
    const offset = MAX_TIMEOUT_MS + 10_000
    service.arm(makeRecord('r-far', offset))
    const start = clockMs

    advanceTo(start + MAX_TIMEOUT_MS)
    await flushAsync()
    expect(fired).toHaveLength(0)
    // 中间段到点后必须已重挂剩余段
    expect(service.isArmed('r-far')).toBe(true)

    advanceTo(start + offset)
    await flushAsync()
    expect(fired).toHaveLength(1)
    expect(service.isArmed('r-far')).toBe(false)
  })
})

describe('ReminderTimerService：撤销与清理', () => {
  it('cancel 后到点不触发；cancel 没挂过的 id 是 no-op', async () => {
    const service = makeService()
    service.arm(makeRecord('r-1', 1_000))
    service.cancel('r-1')
    expect(service.isArmed('r-1')).toBe(false)

    advanceTo(clockMs + 10_000)
    await flushAsync()
    expect(fired).toHaveLength(0)

    expect(() => service.cancel('ghost')).not.toThrow()
  })

  it('dispose 清空所有挂表（应用退出前调用）', async () => {
    const service = makeService()
    service.arm(makeRecord('r-1', 1_000))
    service.arm(makeRecord('r-2', 2_000))

    service.dispose()
    expect(service.isArmed('r-1')).toBe(false)
    expect(service.isArmed('r-2')).toBe(false)

    advanceTo(clockMs + 10_000)
    await flushAsync()
    expect(fired).toHaveLength(0)
  })

  it('重复 arm 同一 id → 旧表被撤，只按新时间触发一次', async () => {
    // scheduler.create 幂等重试、TASK-025 恢复重挂都可能对同一 id 再 arm。
    const service = makeService()
    service.arm(makeRecord('r-1', 1_000))
    const second = makeRecord('r-1', 3_000)
    service.arm(second)

    advanceTo(clockMs + 1_000)
    await flushAsync()
    expect(fired).toHaveLength(0)

    advanceTo(clockMs + 3_000)
    await flushAsync()
    expect(fired).toHaveLength(1)
    expect(fired[0]).toBe(second)
  })
})

describe('ReminderTimerService：触发结果只记录，不重试', () => {
  it('fire 回 send_failed/rejected → warn 记录，不重挂不重发', async () => {
    // failed 只允许显式重试（恢复策略）；timer 不做自动重试。
    fireOutcome = { kind: 'send_failed', reason: '通道忙' }
    const service = makeService()
    service.arm(makeRecord('r-1', 1_000))

    advanceTo(clockMs + 1_000)
    await flushAsync()
    expect(fired).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
    expect(service.isArmed('r-1')).toBe(false)

    advanceTo(clockMs + 100_000)
    await flushAsync()
    expect(fired).toHaveLength(1)
  })

  it('fire 意外 throw → error 记录，不炸出 unhandled rejection', async () => {
    // deps.fire 契约上不 throw；真 throw 说明注入的实现坏了，记录不外溢。
    fireThrows = new Error('fire 实现炸了')
    const service = makeService()
    service.arm(makeRecord('r-1', 1_000))

    advanceTo(clockMs + 1_000)
    await flushAsync()
    expect(errorSpy).toHaveBeenCalled()
  })
})
