import * as z from "zod";
import { CapabilityFailure } from "./host";

export const KnowledgeMode = z.enum(["traditional", "raptor", "viking"]);
export type KnowledgeMode = z.infer<typeof KnowledgeMode>;
export const KnowledgeImportParams = z.object({
  paths: z.array(z.string().trim().min(1)).min(1).max(100),
  mode: KnowledgeMode,
  force: z.boolean().default(false),
});
export type KnowledgeImportParams = z.infer<typeof KnowledgeImportParams>;
export const KnowledgeDocument = z.object({
  id: z.string().min(1), sourcePath: z.string().min(1), fileName: z.string().min(1),
  mode: KnowledgeMode, chunkCount: z.number().int().nonnegative(), updatedAt: z.string(),
});
export type KnowledgeDocument = z.infer<typeof KnowledgeDocument>;
export const KnowledgeImportResult = z.object({
  ok: z.literal(true),
  entries: z.array(z.object({
    sourcePath: z.string(), mode: KnowledgeMode,
    status: z.enum(["indexed", "updated", "skipped_unchanged", "failed"]),
    chunkCount: z.number().int().nonnegative(), message: z.string().optional(),
  })),
});
export type KnowledgeImportResult = z.infer<typeof KnowledgeImportResult>;
export const KnowledgeListResult = z.object({ok: z.literal(true), documents: z.array(KnowledgeDocument)});
export type KnowledgeListResult = z.infer<typeof KnowledgeListResult>;

export const KnowledgeSearchParams = z.object({
  query: z.string().min(1).refine((value) => value.trim().length > 0, "query 不能为空白"),
  mode: KnowledgeMode.optional(),
  topK: z.number().int().min(1).max(50).default(5),
  denseLimit: z.number().int().min(1).max(100).optional(),
  sparseLimit: z.number().int().min(1).max(100).optional(),
  fileTypes: z.array(z.string()).optional(),
  documentIds: z.array(z.string()).optional(),
  minScore: z.number().optional(),
});

export type KnowledgeSearchParams = z.infer<typeof KnowledgeSearchParams>;

export const KnowledgeChunkItem = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  fileName: z.string().min(1),
  sourcePath: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  pageNumbers: z.array(z.number().int().positive()),
  headingPath: z.string().nullable().optional(),
  contextPrefix: z.string().nullable().optional(),
  rawText: z.string(),
  score: z.number(),
  denseRank: z.number().int().positive().nullable().optional(),
  sparseRank: z.number().int().positive().nullable().optional(),
});

export type KnowledgeChunkItem = z.infer<typeof KnowledgeChunkItem>;

export const KnowledgeSearchResult = z.object({
  ok: z.literal(true),
  query: z.string(),
  totalFound: z.number().int().nonnegative(),
  chunks: z.array(KnowledgeChunkItem),
  warnings: z.array(z.string()).optional(),
});

export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>;

export const KnowledgeSearchOutcome = z.discriminatedUnion("ok", [
  KnowledgeSearchResult,
  CapabilityFailure,
]);

export type KnowledgeSearchOutcome = z.infer<typeof KnowledgeSearchOutcome>;
