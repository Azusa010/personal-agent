import * as z from "zod";
import { CapabilityFailure } from "./host";

export const FileSearchMode = z.enum([
  "filename",
  "content_plain",
  "content_regex",
]);
export type FileSearchMode = z.infer<typeof FileSearchMode>;

export const FileSearchParams = z.object({
  pattern: z.string().min(1),
  searchMode: FileSearchMode.optional().default("filename"),
  relativeRoot: z.string().optional(),
  maxMatches: z.number().int().positive().optional().default(50),
});
export type FileSearchParams = z.infer<typeof FileSearchParams>;

export const FileSearchMatch = z.object({
  path: z.string(),
  lineNumber: z.number().int().optional(),
  lineContent: z.string().optional(),
  matchPreview: z.string().optional(),
});
export type FileSearchMatch = z.infer<typeof FileSearchMatch>;

export const FileSearchResult = z.object({
  ok: z.literal(true),
  totalMatches: z.number().int(),
  truncated: z.boolean(),
  matches: z.array(FileSearchMatch),
});
export type FileSearchResult = z.infer<typeof FileSearchResult>;

export const FileSearchOutcome = z.discriminatedUnion("ok", [
  FileSearchResult,
  CapabilityFailure,
]);
export type FileSearchOutcome = z.infer<typeof FileSearchOutcome>;
