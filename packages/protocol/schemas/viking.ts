import * as z from "zod";

export const VikingReadL0Params = z.object({
  uri: z.string().min(1),
});
export type VikingReadL0Params = z.infer<typeof VikingReadL0Params>;

export const VikingReadL0Result = z.object({
  ok: z.literal(true),
  uri: z.string(),
  abstractText: z.string(),
  isValid: z.boolean(),
});
export type VikingReadL0Result = z.infer<typeof VikingReadL0Result>;

export const VikingReadL1Params = z.object({
  uri: z.string().min(1),
});
export type VikingReadL1Params = z.infer<typeof VikingReadL1Params>;

export const VikingReadL1Result = z.object({
  ok: z.literal(true),
  uri: z.string(),
  overviewText: z.string(),
});
export type VikingReadL1Result = z.infer<typeof VikingReadL1Result>;

export const VikingReadL2Params = z.object({
  uri: z.string().min(1),
});
export type VikingReadL2Params = z.infer<typeof VikingReadL2Params>;

export const VikingReadL2Result = z.object({
  ok: z.literal(true),
  uri: z.string(),
  content: z.string(),
});
export type VikingReadL2Result = z.infer<typeof VikingReadL2Result>;

export const VikingWriteL2Params = z.object({
  uri: z.string().min(1),
  content: z.string(),
});
export type VikingWriteL2Params = z.infer<typeof VikingWriteL2Params>;

export const VikingWriteL2Result = z.object({
  ok: z.literal(true),
  uri: z.string(),
  bytesWritten: z.number().int().nonnegative(),
});
export type VikingWriteL2Result = z.infer<typeof VikingWriteL2Result>;
