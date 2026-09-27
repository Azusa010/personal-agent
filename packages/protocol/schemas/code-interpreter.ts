import * as z from "zod";
import { CapabilityFailure } from "./host";

export const CodeInterpreterParams = z.object({
  code: z.string().min(1),
  timeoutMs: z.number().int().positive().optional().default(30000),
  saveArtifacts: z.boolean().optional().default(false),
});
export type CodeInterpreterParams = z.infer<typeof CodeInterpreterParams>;

export const CodeInterpreterResult = z.object({
  ok: z.literal(true),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  artifacts: z.array(z.string()).optional(),
  truncated: z.boolean().optional(),
});
export type CodeInterpreterResult = z.infer<typeof CodeInterpreterResult>;

export const CodeInterpreterOutcome = z.discriminatedUnion("ok", [
  CodeInterpreterResult,
  CapabilityFailure,
]);
export type CodeInterpreterOutcome = z.infer<typeof CodeInterpreterOutcome>;
