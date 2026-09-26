import * as z from "zod";

export const KNOWLEDGE_DIFF_OPS = [
  "ADD",
  "UPDATE",
  "INVALIDATE",
  "QUALIFY",
] as const;
export type KnowledgeDiffOpType = (typeof KNOWLEDGE_DIFF_OPS)[number];
export const KnowledgeDiffOpEnum = z.enum(KNOWLEDGE_DIFF_OPS);

export const KNOWLEDGE_TARGET_TYPES = [
  "user_memory",
  "document_chunk",
  "viking_wiki",
] as const;
export type KnowledgeTargetType = (typeof KNOWLEDGE_TARGET_TYPES)[number];
export const KnowledgeTargetTypeEnum = z.enum(KNOWLEDGE_TARGET_TYPES);

export const KnowledgeDiffOp = z.object({
  op: KnowledgeDiffOpEnum,
  targetType: KnowledgeTargetTypeEnum,
  targetId: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()),
  evidenceRefs: z.array(z.string().uuid()).min(1),
  qualification: z.string().nullable().optional(),
});
export type KnowledgeDiffOp = z.infer<typeof KnowledgeDiffOp>;

export const KNOWLEDGE_PR_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "revision_requested",
] as const;
export type KnowledgePrStatus = (typeof KNOWLEDGE_PR_STATUSES)[number];
export const KnowledgePrStatusEnum = z.enum(KNOWLEDGE_PR_STATUSES);

export const KnowledgeProposal = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  targetLayer: KnowledgeTargetTypeEnum,
  proposerModel: z.string().min(1),
  operations: z.array(KnowledgeDiffOp).min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  status: KnowledgePrStatusEnum.default("pending"),
  iterationCount: z.number().int().min(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeProposal = z.infer<typeof KnowledgeProposal>;

export const REVIEW_VERDICTS = [
  "approved",
  "rejected",
  "revision_requested",
] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const ReviewVerdictEnum = z.enum(REVIEW_VERDICTS);

export const CRITIQUE_VERDICTS = ["pass", "reject", "revise"] as const;
export type CritiqueVerdict = (typeof CRITIQUE_VERDICTS)[number];
export const CritiqueVerdictEnum = z.enum(CRITIQUE_VERDICTS);

export const CRITIQUE_ISSUE_TYPES = [
  "lacks_evidence",
  "over_broad_deletion",
  "missing_qualification",
  "format_error",
] as const;
export type CritiqueIssueType = (typeof CRITIQUE_ISSUE_TYPES)[number];
export const CritiqueIssueTypeEnum = z.enum(CRITIQUE_ISSUE_TYPES);

export const KnowledgeReviewCritique = z.object({
  opIndex: z.number().int().nonnegative(),
  verdict: CritiqueVerdictEnum,
  issueType: CritiqueIssueTypeEnum.optional(),
  explanation: z.string().min(1),
  requiredCorrection: z.string().optional(),
  evidenceRef: z.string().uuid().optional(),
});
export type KnowledgeReviewCritique = z.infer<typeof KnowledgeReviewCritique>;

export const KnowledgeReviewOutcome = z.object({
  proposalId: z.string().uuid(),
  reviewerModel: z.string().min(1),
  verdict: ReviewVerdictEnum,
  critiques: z.array(KnowledgeReviewCritique),
  reviewComments: z.string(),
  reviewedAt: z.string(),
});
export type KnowledgeReviewOutcome = z.infer<typeof KnowledgeReviewOutcome>;
