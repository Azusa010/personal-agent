/** 通知的 Port/Adapter 边界 */

export interface NotificationRequest {
  /** 通知标题。生产来源是 fire-reminder.ts 的常量，不是模型输入。 */
  readonly title: string
  /** 通知正文。生产来源是落库的 reminders.message，不是模型输入。 */
  readonly body: string
}

/** 发送结果。ok:false 必须带可落库的原因（reminders.failure_reason） */
export type NotificationOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface NotificationPort {
  /** 发送一条通知并等待真实结果 */
  send(request: NotificationRequest): Promise<NotificationOutcome>
}
