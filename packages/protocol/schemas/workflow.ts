import * as z from "zod";
import { RunTaskResult } from "./agent";

export const AGENT_RUN_WORKFLOW = "agent.run_workflow";

export const RunWorkflowParams = z.object({
  taskId: z.string().min(1),
  workflowId: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

export type RunWorkflowParams = z.infer<typeof RunWorkflowParams>;

export const RunWorkflowRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  method: z.literal(AGENT_RUN_WORKFLOW),
  params: RunWorkflowParams,
});

export const RunWorkflowResponse = z
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

export type RunWorkflowRequest = z.infer<typeof RunWorkflowRequest>;
export type RunWorkflowResponse = z.infer<typeof RunWorkflowResponse>;
