import * as z from "zod";
import { CapabilityFailure } from "./host";

export const SkillMetadata = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  path: z.string().optional(),
});
export type SkillMetadata = z.infer<typeof SkillMetadata>;

export const SkillSearchParams = z.object({
  query: z.string().min(1),
  tag: z.string().optional(),
  maxResults: z.number().int().positive().optional().default(20),
});
export type SkillSearchParams = z.infer<typeof SkillSearchParams>;

export const SkillSearchResult = z.object({
  ok: z.literal(true),
  total: z.number().int().nonnegative(),
  skills: z.array(SkillMetadata),
});
export type SkillSearchResult = z.infer<typeof SkillSearchResult>;

export const SkillSearchOutcome = z.discriminatedUnion("ok", [
  SkillSearchResult,
  CapabilityFailure,
]);
export type SkillSearchOutcome = z.infer<typeof SkillSearchOutcome>;

export const SkillReadParams = z.object({
  name: z.string().min(1),
});
export type SkillReadParams = z.infer<typeof SkillReadParams>;

export const SkillReadResult = z.object({
  ok: z.literal(true),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  content: z.string(),
  path: z.string(),
});
export type SkillReadResult = z.infer<typeof SkillReadResult>;

export const SkillReadOutcome = z.discriminatedUnion("ok", [
  SkillReadResult,
  CapabilityFailure,
]);
export type SkillReadOutcome = z.infer<typeof SkillReadOutcome>;
