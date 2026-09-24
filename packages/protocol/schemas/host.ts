import * as z from "zod";

export const HOST_EXECUTE_TOOL = "host.execute_tool";

export const HOST_CALL_ID_PATTERN = /^call-[0-9]+$/;

export const CapabilityId = z.enum([
  "filesystem_list",
  "document_extract_pdf",
  "filesystem_create_dir",
  "filesystem_move",
  "scheduler_create",
  "notification_send",
  "terminal_execute",
  "knowledge_search",
  "user_memory_search",
]);
export const EXTRACT_PDF_CAPABILITY = CapabilityId.enum["document_extract_pdf"];
export const TERMINAL_EXECUTE_CAPABILITY =
  CapabilityId.enum["terminal_execute"];
export const KNOWLEDGE_SEARCH_CAPABILITY =
  CapabilityId.enum["knowledge_search"];
export const USER_MEMORY_SEARCH_CAPABILITY =
  CapabilityId.enum["user_memory_search"];

export type CapabilityId = z.infer<typeof CapabilityId>;

export const CapabilityKind = z.enum(["READ", "WRITE"]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

export const CapabilityDescriptor = z.object({
  name: CapabilityId,
  kind: CapabilityKind,
  description: z.string().min(1),
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptor>;

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
});

export type CapabilityFailure = z.infer<typeof CapabilityFailure>;
