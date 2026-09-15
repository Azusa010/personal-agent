import { ERROR_CODE } from '@personal-agent/protocol'

import type { ReminderRecord } from '../../shared/domain'
import type { NotificationOutcome, NotificationPort } from '../notifications/notification-port'
import type { SqliteDatabase } from '../product-state/database'
import type { EventRepository } from '../product-state/event-repository'
import type { ReminderRepository } from '../product-state/reminder-repository'

export const NOTIFICATION_SENT_EVENT = 'notification_sent'
export const NOTIFICATION_FAILED_EVENT = 'notification_failed'

/** 通知标题常量 */
export const NOTIFICATION_TITLE = 'PersonalAgent 提醒'

/** rejected 结局用的稳定错误码 */
export const FIRE_REJECTED_CODE = ERROR_CODE.REMINDER_NOT_DUE

/** 一次触发的结局。判别联合，调用方（timer / executor）按 kind 映射：
 *  - sent：本次真的发送并落库 fired；
 *  - already_sent：幂等命中已 fired 的 Reminder，没有重发（「至多一次」）；
 *  - send_failed：适配器报告失败，已落库 failed + failure_reason；
 *  - rejected：不可触发（未到点 / firing 进行中 / 并发竞态），没有碰通知端口。 */
export type FireOutcome =
  | { readonly kind: 'sent'; readonly sentAt: string }
  | { readonly kind: 'already_sent'; readonly sentAt: string }
  | { readonly kind: 'send_failed'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly reason: string }

export interface FireReminderDeps {
  /** 只用来把「状态翻转 + 事件」包进同一事务 */
  readonly db: SqliteDatabase
  readonly reminders: ReminderRepository
  readonly events: EventRepository
  readonly notifications: NotificationPort
  /** 默认 new Date().toISOString()。整次触发用同一个时间戳。 */
  readonly now?: () => string
}

/** 触发一条 Reminder：发送一次并把结果落库。timer 到点与 notification.send
 *  执行体两条入口都收敛到这里，共用同一个状态机保证「至多一次」。
 *
 *  永不 throw：所有失败收进 FireOutcome */
export async function fireReminder(
  reminder: ReminderRecord,
  deps: FireReminderDeps
): Promise<FireOutcome> {
  const stamp = deps.now?.() ?? new Date().toISOString()
  let outcome: NotificationOutcome
  switch (reminder.status) {
    case 'fired':
      return { kind: 'already_sent', sentAt: reminder.firedAt! }
    case 'scheduled':
    case 'failed': {
      if (Date.parse(reminder.remindAt) <= Date.parse(stamp)) {
        try {
          deps.reminders.transition(reminder.id, 'firing', stamp)
        } catch (error) {
          if (error instanceof Error && error.name === 'IllegalReminderTransition') {
            return {
              kind: 'rejected',
              code: FIRE_REJECTED_CODE,
              reason: `Reminder ${reminder.id} 并发触发被拒：${error.message}`
            }
          }
        }
        try {
          outcome = await deps.notifications.send({
            title: NOTIFICATION_TITLE,
            body: reminder.message
          })
        } catch (error) {
          outcome = {
            ok: false,
            reason: `NotificationPort.send 异常：${error instanceof Error ? error.message : String(error)}`
          }
        }
        if (outcome.ok === true) {
          try {
            const commit = deps.db.transaction(() => {
              deps.reminders.transition(reminder.id, 'fired', stamp, { firedAt: stamp })
              deps.events.append({
                taskId: reminder.taskId,
                type: NOTIFICATION_SENT_EVENT,
                payload: { reminderId: reminder.id, sentAt: stamp },
                occurredAt: stamp
              })
            })
            commit()
            return { kind: 'sent', sentAt: stamp }
          } catch (error) {
            console.error('Error occurred while committing transaction:', error)
          }
        }
        if (outcome.ok === false) {
          try {
            const reason = outcome.reason
            const commit = deps.db.transaction(() => {
              deps.reminders.transition(reminder.id, 'failed', stamp, {
                failureReason: reason
              })
              deps.events.append({
                taskId: reminder.taskId,
                type: NOTIFICATION_FAILED_EVENT,
                payload: { reminderId: reminder.id, reason: reason },
                occurredAt: stamp
              })
            })
            commit()
            return { kind: 'send_failed', reason: outcome.reason }
          } catch (error) {
            console.error('Error occurred while committing transaction:', error)
          }
        }
      }
      return {
        kind: 'rejected',
        code: FIRE_REJECTED_CODE,
        // reason 会原样进 CapabilityFailure / 时间线，带上两个时刻，
        // 「为什么没发」在现场一眼可查（对照「状态/时间」的契约要求）。
        reason: `Reminder ${reminder.id} 未到触发时间（remindAt=${reminder.remindAt}，now=${stamp}），拒绝触发`
      }
    }
    case 'firing': {
      return {
        kind: 'rejected',
        code: FIRE_REJECTED_CODE,
        reason: `Reminder ${reminder.id} 正在触发中，拒绝重复触发`
      }
    }
  }
}
