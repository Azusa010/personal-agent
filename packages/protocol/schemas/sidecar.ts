import * as z from "zod";

export const SIDECAR_VERDICTS = [
  "ALLOW",
  "REJECT_WITH_FEEDBACK",
  "ESCALATE_TO_USER",
] as const;
export type SidecarVerdict = (typeof SIDECAR_VERDICTS)[number];
export const SidecarVerdictEnum = z.enum(SIDECAR_VERDICTS);

export const SIDECAR_RISK_CATEGORIES = [
  "NONE",
  "DESTRUCTIVE_COMMAND",
  "CREDENTIAL_EXFILTRATION",
  "PROMPT_INJECTION",
  "SCOPE_ESCAPING",
  "SYSTEM_RESOURCE_ABUSE",
] as const;
export type SidecarRiskCategory = (typeof SIDECAR_RISK_CATEGORIES)[number];
export const SidecarRiskCategoryEnum = z.enum(SIDECAR_RISK_CATEGORIES);

export const CIRCUIT_BREAKER_STATES = [
  "CLOSED",
  "OPEN",
  "HALF_OPEN",
] as const;
export type CircuitBreakerState = (typeof CIRCUIT_BREAKER_STATES)[number];
export const CircuitBreakerStateEnum = z.enum(CIRCUIT_BREAKER_STATES);

/**
 * 实时工具执行安全评估判决契约。
 */
export const SidecarAssessment = z.object({
  callId: z.string().min(1),
  capability: z.string().min(1),
  verdict: SidecarVerdictEnum,
  riskCategory: SidecarRiskCategoryEnum.default("NONE"),
  confidence: z.number().min(0).max(1).default(1.0),
  reason: z.string().min(1),
  remediation: z.string().nullable().optional(),
  assessedBy: z.string().min(1),
  occurredAt: z.string(),
});
export type SidecarAssessment = z.infer<typeof SidecarAssessment>;

/**
 * 熔断器单次拦截记录。
 */
export const CircuitBreakerRejectionRecord = z.object({
  callId: z.string().min(1),
  capability: z.string().min(1),
  reason: z.string().min(1),
  riskCategory: SidecarRiskCategoryEnum.optional(),
});
export type CircuitBreakerRejectionRecord = z.infer<
  typeof CircuitBreakerRejectionRecord
>;

/**
 * 拒绝熔断器状态变更或跳闸事件。
 */
export const CircuitBreakerEvent = z.object({
  taskId: z.string().min(1),
  state: CircuitBreakerStateEnum,
  consecutiveRejections: z.number().int().nonnegative(),
  triggerReason: z.string().min(1),
  recentRejections: z.array(CircuitBreakerRejectionRecord),
  occurredAt: z.string(),
});
export type CircuitBreakerEvent = z.infer<typeof CircuitBreakerEvent>;

/**
 * 超长工具输出动态压缩契约。
 */
export const SidecarCompactedObservation = z.object({
  callId: z.string().min(1),
  capability: z.string().min(1),
  originalChars: z.number().int().nonnegative(),
  compactedChars: z.number().int().nonnegative(),
  summary: z.string().min(1),
  keyFacts: z.array(z.string()),
  rawArtifactRef: z.string().nullable().optional(),
});
export type SidecarCompactedObservation = z.infer<
  typeof SidecarCompactedObservation
>;
