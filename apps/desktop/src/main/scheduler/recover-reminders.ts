import type { ReminderRecord, ReminderStatus } from '../../shared/domain'
import type { EventRepository } from '../product-state/event-repository'
import type { ReminderRepository } from '../product-state/reminder-repository'
import { NOTIFICATION_SENT_EVENT, type FireOutcome } from './fire-reminder'

/**
 * 启动恢复（TASK-025）：应用启动时把 reminders 表里的存量记录重新接回运行态。
 *
 * 策略表：
 *   scheduled 未来 → 重挂 timer，到点再由 fireReminder 发；
 *   scheduled 过期 → 补发一次「错过的提醒」，随后 fired；
 *   firing 有 notification_sent → 只补记 fired，绝不重发；
 *   firing 无证据 → 回滚 scheduled（结果未知不敢算发过），再按过期与否分流；
 *   fired 终态永不再发；failed 保留原因，只允许显式重试。
 *
 * 本文件是编排（扫表 → 判定 → 落动作），判定表收在 decideRecovery：
 * 纯函数，输入三个事实、输出四种处置。验收是 recover-reminders.test.ts 的十例重启测试。
 *
 * 异常边界：单条记录处理失败收进 RecoveryOutcome.errored，不影响其余记录
 * ——恢复是启动路径，不能被一条坏记录拖垮；但 reminders 表本身读不出来时
 * 会 throw，调用方（TASK-028 的生产接线）按 reconcileOrphanTasks 的同款
 * 用 try/catch 包住启动流程。
 */

/** 恢复判定的三个输入事实。库、时钟、事件都被挡在外面，判定因此可以纯函数式断言。 */
export interface RecoverySignals {
  /** 库里读到的当前状态 */
  readonly status: ReminderStatus
  /** 该 Reminder 已有 notification_sent 事件：发送动作确实发生过 */
  readonly hasSentEvent: boolean
  /** remind_at <= 启动时刻：已过期 */
  readonly overdue: boolean
}

/** 一条 Reminder 的处置动作 */
export type RecoveryDecision =
  /** 重挂 timer（含 firing 回滚之后的重挂） */
  | { readonly kind: 'arm' }
  /** 立刻补发一次（错过的提醒；firing 回滚后也走这里） */
  | { readonly kind: 'fire' }
  /** 通知确认已发出：只补记 fired，不重发 */
  | { readonly kind: 'complete' }
  /** 原样保留，恢复不碰 */
  | { readonly kind: 'skip'; readonly reason: 'fired' | 'failed' }

/**
 * 恢复策略判定表 —— 本 TASK 的核心
 *
 * | status    | 证据 / 时间          | 处置                 | 理由                                        |
 * | --------- | -------------------- | -------------------- | ------------------------------------------- |
 * | scheduled | 未到点               | arm                  | 未来提醒：重挂 timer 等它到点                |
 * | scheduled | 已到点（错过）       | fire                 | 启动补发一次「错过的提醒」，随后 fired        |
 * | firing    | 有 sent 事件         | complete             | 通知确认已发出，只补记 fired，绝不重发        |
 * | firing    | 无 sent 事件         | overdue ? fire : arm | 结果未知不敢算发过：回滚后按过期与否分流      |
 * | fired     | —                    | skip('fired')        | 终态，永不重发（「最多通知一次」的地板）      |
 * | failed    | —                    | skip('failed')       | 保留失败原因，只允许显式重试                  |
 */
export function decideRecovery(signals: RecoverySignals): RecoveryDecision {
  switch (signals.status) {
    case 'scheduled': {
      if (signals.overdue) {
        return { kind: 'fire' }
      }
      return { kind: 'arm' }
    }
    case 'firing': {
      if (signals.hasSentEvent) {
        return { kind: 'complete' }
      }
      return signals.overdue ? { kind: 'fire' } : { kind: 'arm' }
    }
    case 'fired':
      return { kind: 'skip', reason: 'fired' }
    case 'failed':
      return { kind: 'skip', reason: 'failed' }
  }
}

/** 「通知已发出」的证据。firing 残留到底发没发过，只能靠它判定。 */
export interface SentEventEvidence {
  /** 事件存在 = 发送动作发生过。以事件存在为准，不重发。 */
  readonly found: boolean
  /** 事件 payload.sentAt；事件不存在、或 payload 里没有可用时间时为 null */
  readonly sentAt: string | null
}

/** 在该 Task 的事件流里找这条 Reminder 的 notification_sent。
 *  execution_events.payload 不设 schema，这里逐字段收窄。 */
export function findSentEventEvidence(
  events: EventRepository,
  reminder: ReminderRecord
): SentEventEvidence {
  const sent = events
    .listByTask(reminder.taskId)
    .find(
      (event) =>
        event.type === NOTIFICATION_SENT_EVENT &&
        payloadField(event.payload, 'reminderId') === reminder.id
    )
  if (sent === undefined) {
    return { found: false, sentAt: null }
  }
  const sentAt = payloadField(sent.payload, 'sentAt')
  return { found: true, sentAt: typeof sentAt === 'string' && sentAt !== '' ? sentAt : null }
}

/** 恢复后每一条的处置结局。数组按 findAll 顺序（remind_at 升序）排列，
 *  启动日志可以整串打出来。 */
export type RecoveryOutcome =
  /** 未来提醒已交给 timer */
  | { readonly kind: 'rearmed'; readonly reminderId: string }
  /** 错过的提醒补发成功，记录已 fired */
  | { readonly kind: 'fired_missed'; readonly reminderId: string }
  /** firing 残留补记 fired，没有重发（含并发下幂等命中已 fired） */
  | { readonly kind: 'completed'; readonly reminderId: string }
  /** 原样保留：fired 终态不再发，failed 等显式重试 */
  | { readonly kind: 'skipped'; readonly reminderId: string; readonly reason: 'fired' | 'failed' }
  /** 补发失败，记录已翻 failed 并带上原因 */
  | { readonly kind: 'send_failed'; readonly reminderId: string; readonly reason: string }
  /** 补发被拒（并发等），记录保持可触发状态 */
  | { readonly kind: 'rejected'; readonly reminderId: string; readonly reason: string }
  /** 单条处理异常：本轮跳过这一条，不影响其余 */
  | { readonly kind: 'errored'; readonly reminderId: string; readonly reason: string }

export interface RecoverRemindersDeps {
  readonly reminders: ReminderRepository
  readonly events: EventRepository
  /** 重挂钩子：生产传 ReminderTimerService.arm 绑好的实例。
   *  恢复只决定「哪些要重挂」，「何时触发」是 timer 的事。 */
  readonly arm: (reminder: ReminderRecord) => void
  /** 补发动作：生产传绑好仓储与通知端口的 fireReminder。
   *  契约与 timer 的 deps.fire 相同——永不 throw，失败收进 FireOutcome。 */
  readonly fire: (reminder: ReminderRecord) => Promise<FireOutcome>
  /** 默认 new Date().toISOString()。整轮恢复共用一个启动时刻。 */
  readonly now?: () => string
}

/** 扫一遍 reminders，把每条接回运行态。返回逐条的处置结局。 */
export async function recoverReminders(
  deps: RecoverRemindersDeps
): Promise<readonly RecoveryOutcome[]> {
  const now = deps.now?.() ?? new Date().toISOString()
  const outcomes: RecoveryOutcome[] = []
  for (const reminder of deps.reminders.findAll()) {
    try {
      outcomes.push(await recoverOne(reminder, deps, now))
    } catch (error) {
      console.error(`[recovery] Reminder ${reminder.id} 恢复失败，跳过这一条`, error)
      outcomes.push({ kind: 'errored', reminderId: reminder.id, reason: describe(error) })
    }
  }
  return outcomes
}

/** 单条恢复：读发送证据 → 判定 → 落动作。 */
async function recoverOne(
  reminder: ReminderRecord,
  deps: RecoverRemindersDeps,
  now: string
): Promise<RecoveryOutcome> {
  const evidence = findSentEventEvidence(deps.events, reminder)
  const decision = decideRecovery({
    status: reminder.status,
    hasSentEvent: evidence.found,
    overdue: Date.parse(reminder.remindAt) <= Date.parse(now)
  })

  switch (decision.kind) {
    case 'skip':
      return { kind: 'skipped', reminderId: reminder.id, reason: decision.reason }

    case 'arm':
      // firing 残留不能直接挂表：fireReminder 见 firing 会整条拒绝，
      // 得先把记录回滚到可触发状态，timer 到点才有意义。
      deps.arm(rollbackIfFiring(reminder, deps, now))
      return { kind: 'rearmed', reminderId: reminder.id }

    case 'complete':
      // 通知确认已发出：只补记终态。有事件时间就用事件时间，缺了用启动时刻兜底。
      deps.reminders.transition(reminder.id, 'fired', now, { firedAt: evidence.sentAt ?? now })
      return { kind: 'completed', reminderId: reminder.id }

    case 'fire': {
      const outcome = await deps.fire(rollbackIfFiring(reminder, deps, now))
      switch (outcome.kind) {
        case 'sent':
          return { kind: 'fired_missed', reminderId: reminder.id }
        case 'already_sent':
          // 并发下别的入口已经发过（fireReminder 的幂等命中）：同样算「已完成」。
          return { kind: 'completed', reminderId: reminder.id }
        case 'send_failed':
          return { kind: 'send_failed', reminderId: reminder.id, reason: outcome.reason }
        case 'rejected':
          return { kind: 'rejected', reminderId: reminder.id, reason: outcome.reason }
      }
    }
  }
}

/** firing → scheduled 回滚：结果未知不敢算发过，重挂回待触发状态。
 *  其它状态原样返回（调用方拿它去 arm / fire）。 */
function rollbackIfFiring(
  reminder: ReminderRecord,
  deps: RecoverRemindersDeps,
  now: string
): ReminderRecord {
  if (reminder.status !== 'firing') return reminder
  return deps.reminders.transition(reminder.id, 'scheduled', now)
}

function payloadField(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[key]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
