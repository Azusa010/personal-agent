import * as z from "zod";
import { CapabilityFailure } from "./host";

export const KnowledgeSearchParams = z.object({
  query: z.string().min(1),
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
});

export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>;

export const KnowledgeSearchOutcome = z.discriminatedUnion("ok", [
  KnowledgeSearchResult,
  CapabilityFailure,
]);

export type KnowledgeSearchOutcome = z.infer<typeof KnowledgeSearchOutcome>;
