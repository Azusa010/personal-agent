import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export const LOG_SOURCES = ["main", "python", "renderer"] as const;
export const LOG_SCHEMA_VERSION = 1;
export const PYTHON_LOG_PREFIX = "@@PALOG@@";

export type LogLevel = typeof LOG_LEVELS[number];
export type LogSource = typeof LOG_SOURCES[number];

export const LogRecord = z.looseObject({
    schemaVersion: z.literal(LOG_SCHEMA_VERSION),
    id: z.string().min(1),
    ts: z.string().min(1),
    level: z.enum(LOG_LEVELS),
    source: z.enum(LOG_SOURCES),
    event: z.string().min(1),
    code: z.string().optional(),
    message: z.string().min(1),
    stack: z.string().optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{40}$/),
    sessionId: z.string(),
    taskId: z.string().optional(),
    traceId: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    context: z.record(z.string(),z.unknown()).optional()
})


export type LogRecordWire = z.infer<typeof LogRecord>;