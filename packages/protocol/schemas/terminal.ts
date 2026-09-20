import * as z from "zod";

export const TerminalExecuteParams = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type TerminalExecuteParams = z.infer<typeof TerminalExecuteParams>;

export const TerminalExecuteResult = z.object({
  ok: z.literal(true),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type TerminalExecuteResult = z.infer<typeof TerminalExecuteResult>;
