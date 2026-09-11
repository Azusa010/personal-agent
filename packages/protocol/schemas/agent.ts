import * as z from "zod";

export const AGENT_RUN_TASK = "agent.run_task";

// TS 触发一个 Agent 任务的入参
export const RunTaskParams = z.object({
  taskId: z.string().min(1),
  goal: z.string().min(1),
});

const OCCURRED_AT_PATTERN = new RegExp(
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
);
// Python 回传的执行事件
export const RunTaskEvent = z.object({
  type: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string().min(1).regex(OCCURRED_AT_PATTERN),
});

// 摘要的最小单元。pageRefs 允许为空：REQ-007 的「必须有页码引用」由 TASK-014 的
// SummaryVerifier 判定，契约层拒的话错误码会指向 PROTOCOL 而不是「摘要不可信」。
// 但每一项必须是 ≥ 1 的整数：页码从 1 起，0 与负数是生产端算错了。
export const SummaryFact = z.object({
  text: z.string().min(1),
  pageRefs: z.array(z.number().int().min(1)),
});

// Python 跑完一个任务的回传结果
export const RunTaskResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    facts: z.array(SummaryFact),
    events: z.array(RunTaskEvent),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().min(1),
    events: z.array(RunTaskEvent),
  }),
]);

export type RunTaskParams = z.infer<typeof RunTaskParams>;
export type RunTaskEvent = z.infer<typeof RunTaskEvent>;
export type SummaryFact = z.infer<typeof SummaryFact>;
export type RunTaskResult = z.infer<typeof RunTaskResult>;

// id 不钉格式：TS → Python 方向的 id 由 supervisor 自己生成并自己匹配，
// 不像 host.execute_tool 那样需要 Python 侧预测（那边钉了 call-\d+）。
export const RunTaskRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  method: z.literal(AGENT_RUN_TASK),
  params: RunTaskParams,
});

export const RunTaskResponse = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: RunTaskResult.optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .superRefine((res, ctx) => {
    if ((res.result !== undefined) === (res.error !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "result and error must not be present at the same time",
      });
    }
  });

export type RunTaskRequest = z.infer<typeof RunTaskRequest>;
export type RunTaskResponse = z.infer<typeof RunTaskResponse>;
