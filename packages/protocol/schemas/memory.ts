import * as z from "zod";
import { CapabilityFailure } from "./host";

export const MEMORY_TYPES = ["semantic", "episodic", "procedural"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MemoryTypeEnum = z.enum(MEMORY_TYPES);

export const MEMORY_CATEGORIES = [
  "preference",
  "identity",
  "relationship",
  "work",
  "routine",
  "general",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export const MemoryCategoryEnum = z.enum(MEMORY_CATEGORIES);

export const UserMemoryCard = z.object({
  id: z.string().uuid(),
  memoryType: MemoryTypeEnum,
  category: MemoryCategoryEnum,
  subject: z.string().min(1),
  person: z.string().nullable().optional(),
  relationship: z.string().nullable().optional(),
  content: z.record(z.string(), z.unknown()),
  backstory: z.string().nullable().optional(),
  sourceTaskId: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  occurredAt: z.string().nullable().optional(),
  validFrom: z.string(),
  supersededBy: z.string().uuid().nullable().optional(),
  supersedeReason: z.string().nullable().optional(),
  accessCount: z.number().int().nonnegative().default(0),
  lastAccessedAt: z.string().nullable().optional(),
  isSanitized: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type UserMemoryCard = z.infer<typeof UserMemoryCard>;

export const UserMemorySearchParams = z.object({
  query: z.string().min(1),
  memoryType: MemoryTypeEnum.optional(),
  category: MemoryCategoryEnum.optional(),
  subject: z.string().optional(),
  person: z.string().optional(),
  relationship: z.string().optional(),
  occurredAfter: z.string().optional(),
  occurredBefore: z.string().optional(),
  topK: z.number().int().min(1).max(50).default(5),
  includeSuperseded: z.boolean().default(false),
  minScore: z.number().optional(),
});

export type UserMemorySearchParams = z.infer<typeof UserMemorySearchParams>;

export const UserMemorySearchItem = z.object({
  card: UserMemoryCard,
  score: z.number(),
  denseRank: z.number().int().positive().nullable().optional(),
  sparseRank: z.number().int().positive().nullable().optional(),
  matchedText: z.string(),
});

export type UserMemorySearchItem = z.infer<typeof UserMemorySearchItem>;

export const UserMemorySearchResult = z.object({
  ok: z.literal(true),
  query: z.string(),
  totalFound: z.number().int().nonnegative(),
  items: z.array(UserMemorySearchItem),
});

export type UserMemorySearchResult = z.infer<typeof UserMemorySearchResult>;

export const UserMemorySearchOutcome = z.discriminatedUnion("ok", [
  UserMemorySearchResult,
  CapabilityFailure,
]);

export type UserMemorySearchOutcome = z.infer<typeof UserMemorySearchOutcome>;
