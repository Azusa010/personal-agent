import * as z from "zod";

export const HOST_EXECUTE_TOOL = "host.execute_tool";

export const HOST_CALL_ID_PATTERN = /^call-[0-9]+$/;

export const CapabilityId = z.enum([
  "filesystem.list",
  "document.extract_pdf",
  "filesystem.create_dir",
  "filesystem.move",
  "scheduler.create",
  "notification.send",
]);

export type CapabilityId = z.infer<typeof CapabilityId>;

export const HostExecuteToolParams = z.object({
  callId: z.string().min(1),
  capability: CapabilityId,
  arguments: z.record(z.string(), z.unknown()),
});

export const HostExecuteToolResult = z.looseObject({
  ok: z.boolean(),
});

export const HostExecuteToolRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().regex(HOST_CALL_ID_PATTERN),
  method: z.literal(HOST_EXECUTE_TOOL),
  params: HostExecuteToolParams,
});

export const HostExecuteToolResponse = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().regex(HOST_CALL_ID_PATTERN),
    result: HostExecuteToolResult.optional(),
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
