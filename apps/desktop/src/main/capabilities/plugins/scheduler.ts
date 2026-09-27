import { randomUUID } from 'node:crypto'

import { ERROR_CODE, NotificationSendParams, SchedulerCreateParams } from '@personal-agent/protocol'

import type { ReminderRecord } from '../../../shared/domain'
import { ReminderAlreadyExists } from '../../product-state/reminder-repository'
import { idempotencyKey } from '../idempotency'
import { fireReminder } from '../../scheduler/fire-reminder'
import type { CapabilityPlugin } from '../plugin'
import { describeError, fail, invalid } from './helpers'

export const REMINDER_CREATED_EVENT = 'reminder_created'

export const schedulerCreatePlugin: CapabilityPlugin = {
  name: 'scheduler_create',
  descriptor: {
    name: 'scheduler_create',
    kind: 'WRITE',
    description: '创建 Reminder'
  },
  async bindArguments(args) {
    const parsed = SchedulerCreateParams.safeParse(args)
    if (!parsed.success) return invalid('scheduler_create', parsed.error.message)

    const remindAt = new Date(parsed.data.remindAt)
    if (Number.isNaN(remindAt.getTime())) {
      return {
        ok: false,
        code: ERROR_CODE.INVALID_ARGUMENT,
        reason: `scheduler_create 的 remindAt 无法解析为时间: ${parsed.data.remindAt}`
      }
    }
    const remindAtIso = remindAt.toISOString()
    if (remindAt.getTime() <= Date.now()) {
      return {
        ok: false,
        code: ERROR_CODE.REMINDER_TIME_IN_PAST,
        reason: `提醒时间 ${remindAtIso} 不晚于当前时间，拒绝创建已到期的 Reminder`
      }
    }
    return {
      ok: true,
      bound: { args: { remindAt: remindAtIso, message: parsed.data.message }, paths: {} }
    }
  },
  async execute(call, context) {
    const scheduler = context.scheduler
    if (scheduler === undefined) {
      return fail(ERROR_CODE.NOT_IMPLEMENTED, 'scheduler_create 没有接线 Reminder 存储')
    }
    const remindAt = String(call.bound.args['remindAt'])
    const message = String(call.bound.args['message'])
    const key = idempotencyKey(call.taskId, call.capability.name, call.bound)

    const existing = scheduler.reminders.findByTaskId(call.taskId)
    if (existing !== null) {
      if (existing.idempotencyKey === key) {
        return {
          ok: true,
          reminderId: existing.id,
          remindAt: existing.remindAt,
          status: existing.status,
          created: false
        }
      }
      return fail(
        ERROR_CODE.REMINDER_ALREADY_EXISTS,
        `任务 ${call.taskId} 已有 Reminder ${existing.id}（${existing.remindAt}），拒绝再建第二个`
      )
    }

    const stamp = scheduler.now?.() ?? new Date().toISOString()
    const record: ReminderRecord = {
      id: scheduler.newId?.() ?? randomUUID(),
      taskId: call.taskId,
      toolCallId: call.callId,
      remindAt,
      message,
      idempotencyKey: key,
      status: 'scheduled',
      createdAt: stamp,
      updatedAt: stamp,
      firedAt: null,
      failureReason: null
    }
    try {
      const commit = scheduler.db.transaction(() => {
        scheduler.reminders.insert(record)
        scheduler.events.append({
          taskId: call.taskId,
          type: REMINDER_CREATED_EVENT,
          payload: {
            reminderId: record.id,
            toolCallId: record.toolCallId,
            remindAt: record.remindAt,
            message: record.message,
            idempotencyKey: record.idempotencyKey
          },
          occurredAt: stamp
        })
      })
      commit()
    } catch (e) {
      if (e instanceof ReminderAlreadyExists) {
        return fail(ERROR_CODE.REMINDER_ALREADY_EXISTS, e.message)
      }
      return fail(ERROR_CODE.SCHEDULER_CREATE_FAILED, `Reminder 落库失败 (${describeError(e)})`)
    }
    try {
      scheduler.armTimer?.(record)
    } catch (e) {
      console.error(`[executor] Reminder ${record.id} 挂表失败，等启动恢复兜底`, e)
    }
    return { ok: true, reminderId: record.id, remindAt, status: 'scheduled', created: true }
  }
}

export const notificationSendPlugin: CapabilityPlugin = {
  name: 'notification_send',
  descriptor: {
    name: 'notification_send',
    kind: 'WRITE',
    description: '发送系统通知'
  },
  async bindArguments(args) {
    const parsed = NotificationSendParams.safeParse(args)
    if (!parsed.success) return invalid('notification_send', parsed.error.message)
    return { ok: true, bound: { args: { reminderId: parsed.data.reminderId }, paths: {} } }
  },
  async execute(call, context) {
    const scheduler = context.scheduler
    if (scheduler?.notifications === undefined) {
      return fail(ERROR_CODE.NOT_IMPLEMENTED, 'notification_send 没有接线通知端口')
    }
    const reminderId = String(call.bound.args['reminderId'])
    const reminder = scheduler.reminders.findById(reminderId)
    if (reminder === null) {
      return fail(ERROR_CODE.REMINDER_NOT_FOUND, `Reminder 不存在: ${reminderId}`)
    }
    if (reminder.taskId !== call.taskId) {
      return fail(ERROR_CODE.REMINDER_NOT_FOUND, `Reminder 不存在: ${reminderId}`)
    }
    const outcome = await fireReminder(reminder, {
      db: scheduler.db,
      reminders: scheduler.reminders,
      events: scheduler.events,
      notifications: scheduler.notifications,
      now: scheduler.now
    })
    switch (outcome.kind) {
      case 'sent':
        return { ok: true, reminderId, status: 'fired', sentAt: outcome.sentAt, sent: true }
      case 'already_sent':
        return { ok: true, reminderId, status: 'fired', sentAt: outcome.sentAt, sent: false }
      case 'send_failed':
        return fail(ERROR_CODE.NOTIFICATION_SEND_FAILED, outcome.reason)
      case 'rejected':
        return fail(outcome.code, outcome.reason)
    }
  }
}
