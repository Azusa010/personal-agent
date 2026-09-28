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

export const AGENT_RESET_CIRCUIT_BREAKER = "agent.reset_circuit_breaker";

export const ResetCircuitBreakerParams = z.object({
  taskId: z.string().min(1),
  reason: z.string().optional(),
});
export type ResetCircuitBreakerParams = z.infer<
  typeof ResetCircuitBreakerParams
>;

export const ResetCircuitBreakerResult = z.object({
  ok: z.boolean(),
  state: CircuitBreakerStateEnum,
  message: z.string(),
});
export type ResetCircuitBreakerResult = z.infer<
  typeof ResetCircuitBreakerResult
>;

export const ResetCircuitBreakerRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  method: z.literal(AGENT_RESET_CIRCUIT_BREAKER),
  params: ResetCircuitBreakerParams,
});
export type ResetCircuitBreakerRequest = z.infer<
  typeof ResetCircuitBreakerRequest
>;

export const ResetCircuitBreakerResponse = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: ResetCircuitBreakerResult.optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .superRefine((res, ctx) => {
    if ((res.result !== undefined) === (res.error !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "result and error must not be present at the same time",
      });
    }
  });
export type ResetCircuitBreakerResponse = z.infer<
  typeof ResetCircuitBreakerResponse
>;

