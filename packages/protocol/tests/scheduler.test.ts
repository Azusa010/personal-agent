import { describe, it, expect } from "vitest";

import {
  ReminderStatus,
  SchedulerCreateOutcome,
  SchedulerCreateParams,
  SchedulerCreateResult,
} from "../schemas/scheduler.js";

/**
 * scheduler.create 的 payload 级契约（TASK-023）。
 *
 * envelope.test.ts 那套是 envelope 级的（按文件名前缀选 schema），
 * 这里校验的是 binder 与 executor 之间的关口形状。Python 侧的对称用例
 * 在 services/agent-runtime/tests/test_protocol_fixtures.py。
 */
describe("SchedulerCreateParams", () => {
  it("接受具体时间 + 通知内容", () => {
    expect(
      SchedulerCreateParams.parse({
        remindAt: "2026-09-15T20:00:00.000Z",
        message: "该阅读 report-2026.pdf 的摘要了",
      }),
    ).toEqual({
      remindAt: "2026-09-15T20:00:00.000Z",
      message: "该阅读 report-2026.pdf 的摘要了",
    });
  });

  it("拒绝空 remindAt", () => {
    // min(1) 挡的是模型给出空字符串。放过去的话 binder 会拿 '' 去 new Date，
    // 得到 Invalid Date，报错现场离源头更远。
    expect(
      SchedulerCreateParams.safeParse({ remindAt: "", message: "x" }).success,
    ).toBe(false);
  });

  it("拒绝缺 message", () => {
    // message 是到期通知的正文（PRD 4.8 Reminder 的「通知内容」），
    // 缺了它 TASK-024 的通知就没有内容可发。
    expect(
      SchedulerCreateParams.safeParse({ remindAt: "2026-09-15T20:00:00.000Z" })
        .success,
    ).toBe(false);
  });

  it("拒绝非字符串 remindAt", () => {
    expect(
      SchedulerCreateParams.safeParse({ remindAt: 1789495200000, message: "x" })
        .success,
    ).toBe(false);
  });

  it("不校验时间是否可解析、是否在未来", () => {
    // 契约层只钉形状。「今晚」解析成几点、是不是已经过了，是 host 侧
    // binder 的职责（REMINDER_TIME_IN_PAST）。这条钉住契约层没有偷偷
    // 承担语义校验，否则两处校验会各自演化。
    expect(
      SchedulerCreateParams.safeParse({ remindAt: "今晚八点", message: "x" })
        .success,
    ).toBe(true);
    expect(
      SchedulerCreateParams.safeParse({
        remindAt: "1999-01-01T00:00:00.000Z",
        message: "x",
      }).success,
    ).toBe(true);
  });
});

describe("ReminderStatus", () => {
  it("四个合法状态都接受", () => {
    for (const status of ["scheduled", "firing", "fired", "failed"]) {
      expect(ReminderStatus.safeParse(status).success, status).toBe(true);
    }
  });

  it("枚举外的值拒绝", () => {
    // expired/pending 是 Permission 的词表，串进来就是契约漂移。
    expect(ReminderStatus.safeParse("expired").success).toBe(false);
    expect(ReminderStatus.safeParse("pending").success).toBe(false);
    expect(ReminderStatus.safeParse("").success).toBe(false);
  });
});

describe("SchedulerCreateResult", () => {
  const valid = {
    ok: true as const,
    reminderId: "3f6a9c1e-8b4d-4f2a-9c7e-1d5b8a2e4f60",
    remindAt: "2026-09-15T20:00:00.000Z",
    status: "scheduled" as const,
    created: true,
  };

  it("接受完整结果，字段一个不多一个不少", () => {
    expect(SchedulerCreateResult.parse(valid)).toEqual(valid);
    expect(Object.keys(SchedulerCreateResult.parse(valid))).toHaveLength(5);
  });

  it("拒绝空 reminderId", () => {
    expect(
      SchedulerCreateResult.safeParse({ ...valid, reminderId: "" }).success,
    ).toBe(false);
  });

  it("拒绝非法 status", () => {
    expect(
      SchedulerCreateResult.safeParse({ ...valid, status: "done" }).success,
    ).toBe(false);
  });

  it("created:false 合法：幂等命中同任务已有 Reminder 时返回它", () => {
    // TASK-023 验收「同一 Task 不创建重复 Reminder」的 wire 表达：
    // 重试命中已有记录不算失败，用 created 区分「本次新建」与「本就存在」。
    expect(
      SchedulerCreateResult.safeParse({ ...valid, created: false }).success,
    ).toBe(true);
  });
});

describe("SchedulerCreateOutcome", () => {
  it("判别到成功分支", () => {
    const parsed = SchedulerCreateOutcome.parse({
      ok: true,
      reminderId: "r-1",
      remindAt: "2026-09-15T20:00:00.000Z",
      status: "scheduled",
      created: true,
    });
    expect(parsed.ok).toBe(true);
    // 判别联合收窄之后 reminderId 可访问
    if (parsed.ok) {
      expect(parsed.reminderId).toBe("r-1");
    }
  });

  it("判别到失败分支", () => {
    const parsed = SchedulerCreateOutcome.parse({
      ok: false,
      code: "REMINDER_ALREADY_EXISTS",
      reason: "任务 t-1 已有 Reminder r-0",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("REMINDER_ALREADY_EXISTS");
    }
  });

  it("缺 ok 时拒绝，而不是猜一个分支", () => {
    const r = SchedulerCreateOutcome.safeParse({
      reminderId: "r-1",
      remindAt: "2026-09-15T20:00:00.000Z",
      status: "scheduled",
      created: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["ok"]);
    }
  });
});
