import * as z from "zod";
import { CapabilityFailure } from "./host";
import { ReminderStatus } from "./scheduler";

// notification.send（TASK-024）：仅由持久化 Reminder 触发（PRD 3.2）。
// 参数只有 reminderId 引用——通知正文来自落库的 reminders.message，时间来自
// remindAt，模型传不进自由文本。存在性、归属、可触发状态、是否到点由 host
// 侧执行体判定（REMINDER_NOT_FOUND / REMINDER_NOT_DUE），与 SchedulerCreateParams
// 不校验时间语义是同一个分层原则：契约钉形状，语义归执行链。
export const NotificationSendParams = z.object({
  reminderId: z.string().min(1),
});

export type NotificationSendParams = z.infer<typeof NotificationSendParams>;

// sent 区分「本次真的发送了」与「幂等命中已 fired 的 Reminder」（仿
// SchedulerCreateResult.created）。「同一 Reminder 最多通知一次」的 wire 表达：
// 重复触发不算失败，但也绝不重发。
// sentAt 是翻到 fired 的时刻（reminders.fired_at）；幂等返回时带回原值。
// status 在 ok:true 时只会是 fired——发送失败走 CapabilityFailure
// （NOTIFICATION_SEND_FAILED），不伪造成功（US-06）。
export const NotificationSendResult = z.object({
  ok: z.literal(true),
  reminderId: z.string().min(1),
  status: ReminderStatus,
  sentAt: z.string().min(1),
  sent: z.boolean(),
});

export type NotificationSendResult = z.infer<typeof NotificationSendResult>;

export const NotificationSendOutcome = z.discriminatedUnion("ok", [
  NotificationSendResult,
  CapabilityFailure,
]);

export type NotificationSendOutcome = z.infer<typeof NotificationSendOutcome>;
