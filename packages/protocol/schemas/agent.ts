import * as z from "zod";

// TS 触发一个 Agent 任务的入参
export const RunTaskParams = z.object({
  taskId: z.string().min(1),
  goal: z.string().min(1),
});


const occurredAtRegex = new RegExp("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");
// Python 回传的执行事件
export const RunTaskEvent = z.object({
  type: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string().min(1).regex(occurredAtRegex),
});

// 摘要的最小单元，至少包含一个字符和一个页引用
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


