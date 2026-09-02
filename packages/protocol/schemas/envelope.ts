import * as z from "zod";

export const METHOD_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  method: z.string().regex(METHOD_PATTERN),
  params: z.unknown(),
});

export const Response = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .superRefine((res, ctx) => {
    const hasResult = res.result !== undefined;
    const hasError = res.error !== undefined;
    if (hasResult === hasError) {
      ctx.addIssue({
        code: "custom",
        message: "result and error must not be present at the same time",
      });
    }
  });

export const Notification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().regex(METHOD_PATTERN),
  params: z.unknown(),
});
