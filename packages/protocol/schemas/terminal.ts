import * as z from "zod";

export const TerminalExecuteParams = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  // --- expected_* 审计参数（可选）---
  expected_cwd_exists: z.boolean().optional(),
});

export type TerminalExecuteParams = z.infer<typeof TerminalExecuteParams>;

export const TerminalExecuteResult = z.object({
  ok: z.literal(true),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type TerminalExecuteResult = z.infer<typeof TerminalExecuteResult>;
