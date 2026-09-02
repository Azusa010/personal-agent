import * as z from "zod";

export const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
});

export const Response = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  result: z.unknown().optional().superRefine,
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional().superRefine,
});

export const Notification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown(),
});
