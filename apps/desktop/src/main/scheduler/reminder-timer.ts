import type { ReminderRecord } from '../../shared/domain'
import type { FireOutcome } from './fire-reminder'

/** Node 的 setTimeout 延迟上限是 2^31-1 ms（≈24.8 天）。超过它定时器会
 *  溢出并**立即**触发——「下个月提醒我」会变成现在立刻弹通知。
 *  更长的延迟必须分段重挂，见 schedule 的 TODO 契约。 */
export const MAX_TIMEOUT_MS = 2_147_483_647

export type TimerHandle = ReturnType<typeof setTimeout>

export interface ReminderTimerDeps {
  /** 到点后的真实动作：发送 + 记录结果。生产传绑好仓储的 fireReminder，
   *  测试注入假函数。timer 只管「何时」，不管「做什么」。 */
  readonly fire: (reminder: ReminderRecord) => Promise<FireOutcome>
  /** 默认 Date.now()。测试注入可控时钟。 */
  readonly now?: () => number
  /** 默认全局 setTimeout/clearTimeout。测试注入手动时钟配套。 */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimer?: (handle: TimerHandle) => void
}

/** 在跑的 Reminder 定时器集合。一个 reminderId 至多挂一个 timer：
 *  重复 arm 先撤旧再挂新（幂等），到点/取消/清理时从 pending 摘除。
 */
export class ReminderTimerService {
  private readonly pending = new Map<string, TimerHandle>()

  constructor(private readonly deps: ReminderTimerDeps) {}

  /** 给一条 scheduled 的 Reminder 挂表。已挂着就先撤 */
  arm(reminder: ReminderRecord): void {
    this.cancel(reminder.id)
    this.schedule(reminder)
  }

  /** 撤销一条挂表。没挂过是 no-op，不抛异常。 */
  cancel(reminderId: string): void {
    const handle = this.pending.get(reminderId)
    if (handle === undefined) return
    this.pending.delete(reminderId)
    const clearTimer = this.deps.clearTimer ?? clearTimeout
    clearTimer(handle)
  }

  /** 清空所有挂表（应用退出前调用）。 */
  dispose(): void {
    for (const reminderId of [...this.pending.keys()]) {
      this.cancel(reminderId)
    }
  }

  /** 测试与诊断用：这条 Reminder 当前是否挂着表。 */
  isArmed(reminderId: string): boolean {
    return this.pending.has(reminderId)
  }

  private schedule(reminder: ReminderRecord): void {
    const now = this.deps.now?.() ?? Date.now()
    const delayMs = Math.max(0, Date.parse(reminder.remindAt) - now)
    const setTimer = this.deps.setTimer ?? setTimeout

    if (delayMs > MAX_TIMEOUT_MS) {
      const handle = setTimer(() => {
        this.schedule(reminder)
      }, MAX_TIMEOUT_MS)
      this.pending.set(reminder.id, handle)
      return
    }

    const handle = setTimer(() => {
      this.onDue(reminder)
    }, delayMs)
    this.pending.set(reminder.id, handle)
  }

  /** 到点回调：
   *  先从 pending 摘除再触发 fire——摘除在前保证「至多一次」的集合语义，
   *  fire 结果只记录不重试（failed 只允许显式重试，见恢复策略）。 */
  private onDue(reminder: ReminderRecord): void {
    this.pending.delete(reminder.id)
    void this.deps.fire(reminder).then(
      (outcome) => {
        if (outcome.kind !== 'sent' && outcome.kind !== 'already_sent') {
          console.warn(
            `[reminder-timer] Reminder ${reminder.id} 触发未成功 (${outcome.kind})`,
            outcome
          )
        }
      },
      (err: unknown) => {
        // deps.fire 契约上不 throw；真 throw 说明注入的实现坏了，记录不外溢。
        console.error(`[reminder-timer] Reminder ${reminder.id} 触发异常`, err)
      }
    )
  }
}
