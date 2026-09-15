import { describe, it, expect } from "vitest";

import {
  NotificationSendOutcome,
  NotificationSendParams,
  NotificationSendResult,
} from "../schemas/notification.js";

/**
 * notification.send 的 payload 级契约（TASK-024）。
 *
 * envelope.test.ts 那套是 envelope 级的（按文件名登记 fixture），
 * 这里校验的是 binder 与 executor 之间的关口形状。Python 侧的对称用例
 * 在 services/agent-runtime/tests/test_protocol_fixtures.py。
 */
describe("NotificationSendParams", () => {
  it("接受 reminderId 引用", () => {
    expect(
      NotificationSendParams.parse({
        reminderId: "3f6a9c1e-8b4d-4f2a-9c7e-1d5b8a2e4f60",
      }),
    ).toEqual({ reminderId: "3f6a9c1e-8b4d-4f2a-9c7e-1d5b8a2e4f60" });
  });

  it("拒绝空 reminderId", () => {
    // min(1) 挡空串：放过去的话执行体会拿 '' 去 findById，
    // 报错现场离源头更远。
    expect(NotificationSendParams.safeParse({ reminderId: "" }).success).toBe(
      false,
    );
  });

  it("拒绝缺 reminderId", () => {
    expect(NotificationSendParams.safeParse({}).success).toBe(false);
  });

  it("剥掉自由文本字段：正文只能来自落库的 reminders.message", () => {
    // 「仅由持久化 Reminder 触发」（PRD 3.2）的契约层表达：z.object 默认
    // strip 未知键，模型塞的 message/title 到不了执行体。钉住这个行为，
    // 防止将来有人把 schema 放宽成 passthrough。
    const parsed = NotificationSendParams.parse({
      reminderId: "r-1",
      message: "模型想自己编的正文",
      title: "模型想自己编的标题",
    });
    expect(parsed).toEqual({ reminderId: "r-1" });
  });

  it("不校验 reminderId 是否存在、是否属于当前任务", () => {
    // 契约层只钉形状。存在性、归属、可触发状态、是否到点是 host 侧执行体
    // 的职责（REMINDER_NOT_FOUND / REMINDER_NOT_DUE），与 SchedulerCreateParams
    // 不校验时间语义是同一个分层原则。
    expect(
      NotificationSendParams.safeParse({ reminderId: "不存在的-id" }).success,
    ).toBe(true);
  });
});

describe("NotificationSendResult", () => {
  const valid = {
    ok: true as const,
    reminderId: "3f6a9c1e-8b4d-4f2a-9c7e-1d5b8a2e4f60",
    status: "fired" as const,
    sentAt: "2026-09-15T20:00:00.123Z",
    sent: true,
  };

  it("接受完整结果，字段一个不多一个不少", () => {
    expect(NotificationSendResult.parse(valid)).toEqual(valid);
    expect(Object.keys(NotificationSendResult.parse(valid))).toHaveLength(5);
  });

  it("拒绝空 reminderId", () => {
    expect(
      NotificationSendResult.safeParse({ ...valid, reminderId: "" }).success,
    ).toBe(false);
  });

  it("拒绝非法 status", () => {
    // status 复用 ReminderStatus 枚举；成功结果只应是 fired，
    // 但契约层不钉这个语义（钉形状），执行体测试负责钉「ok:true 必 fired」。
    expect(
      NotificationSendResult.safeParse({ ...valid, status: "done" }).success,
    ).toBe(false);
  });

  it("sent:false 合法：幂等命中已 fired 的 Reminder 时返回它", () => {
    // 「同一 Reminder 最多通知一次」的 wire 表达：重复触发不算失败，
    // 用 sent 区分「本次真发了」与「本就发过」。
    expect(
      NotificationSendResult.safeParse({ ...valid, sent: false }).success,
    ).toBe(true);
  });
});

describe("NotificationSendOutcome", () => {
  it("判别到成功分支", () => {
    const parsed = NotificationSendOutcome.parse({
      ok: true,
      reminderId: "r-1",
      status: "fired",
      sentAt: "2026-09-15T20:00:00.123Z",
      sent: true,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.sentAt).toBe("2026-09-15T20:00:00.123Z");
    }
  });

  it("判别到失败分支：发送失败走 CapabilityFailure，不伪造成功", () => {
    const parsed = NotificationSendOutcome.parse({
      ok: false,
      code: "NOTIFICATION_SEND_FAILED",
      reason: "Windows 通知发送失败",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("NOTIFICATION_SEND_FAILED");
    }
  });

  it("缺 ok 时拒绝，而不是猜一个分支", () => {
    const r = NotificationSendOutcome.safeParse({
      reminderId: "r-1",
      status: "fired",
      sentAt: "2026-09-15T20:00:00.123Z",
      sent: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["ok"]);
    }
  });
});
