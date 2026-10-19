import {z} from "zod";

export * from "./logging";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export const LOG_SOURCES = ["main", "python", "renderer"] as const;
export const LOG_SCHEMA_VERSION = "1";
export const PYTHON_LOG_PREFIX = "python";

export type LogLevel = typeof LOG_LEVELS[number];
export type LogSource = typeof LOG_SOURCES[number];
export type LogRecordWire = z.infer<typeof LogRecord>;

export const LogRecord = z.looseObject({
    schemaVersion: z.literal("1"),
    id: z.string().min(1),
    timestamp: z.string(),
    level: z.enum(LOG_LEVELS),
    source: z.enum(LOG_SOURCES),
    event: z.string().min(1),
    code: z.string().optional(),
    message: z.string().min(1),
    stack: z.string().optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{32}$/).optional(),
    sessionId: z.string().optional(),
    taskId: z.string().optional(),
    traceId: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    context: z.object()
})

