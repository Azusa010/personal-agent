import * as z from "zod";
import { CapabilityFailure } from "./host";

// Reminder 的四种状态，与 apps/desktop shared/domain.ts 的 REMINDER_STATUSES
// 及 reminders 表的 CHECK 约束同源（防漂移测试遍历数组做真库插入）。
// scheduled = 待触发；firing = 触发中、通知结果未知；fired = 已发送，终态；
// failed = 通知失败，保留原因，只允许显式重试。
export const ReminderStatus = z.enum(["scheduled", "firing", "fired", "failed"]);

export type ReminderStatus = z.infer<typeof ReminderStatus>

// remindAt 是模型把「今晚」这类自然语言解析后的具体时间（ISO-8601）。
// 契约层只钉形状：能不能解析、是不是未来时刻由 host 侧 binder 判定
//（REMINDER_TIME_IN_PAST），与 DocumentExtractPdfParams 不校验路径越界
// 是同一个分层原则——契约钉形状，语义归执行链。
// message 是到期通知的正文，落 reminders.message。
export const SchedulerCreateParams = z.object({
  remindAt: z.string().min(1),
  message: z.string().min(1),
});

export type SchedulerCreateParams = z.infer<typeof SchedulerCreateParams>

// 仿 FilesystemCreateDirResult：created 区分「本次新建」与「命中同任务已有
// Reminder 的幂等返回」。remindAt 是 binder 规范化后的 UTC ISO（毫秒三位 + Z），
// 与 reminders.remind_at、批准面板展示的时间是同一个串——用户确认的就是落库的。
export const SchedulerCreateResult = z.object({
  ok: z.literal(true),
  reminderId: z.string().min(1),
  remindAt: z.string().min(1),
  status: ReminderStatus,
  created: z.boolean(),
});

export type SchedulerCreateResult = z.infer<typeof SchedulerCreateResult>

export const SchedulerCreateOutcome = z.discriminatedUnion("ok", [
  SchedulerCreateResult,
  CapabilityFailure,
]);

export type SchedulerCreateOutcome = z.infer<typeof SchedulerCreateOutcome>
