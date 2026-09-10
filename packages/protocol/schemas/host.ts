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

export type HostExecuteToolParams = z.infer<typeof HostExecuteToolParams>;

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

export const CapabilityFailure = z.object({
  ok: z.literal(false),
  code: z.string(),
  reason: z.string(),
})

// code 用宽松的 z.string()：收成枚举就得把 PDF_EMPTY / PDF_CORRUPT /
// PDF_ENCRYPTED / PDF_NO_TEXT 全搬进 protocol 包，契约层会变成业务错误码字典。
// 数据形状（PageText）进 protocol，错误码字典留在各自的 capability 文件。
export type CapabilityFailure = z.infer<typeof CapabilityFailure>
