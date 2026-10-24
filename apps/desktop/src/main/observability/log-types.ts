import { LOG_LEVELS, LOG_SOURCES, PYTHON_LOG_PREFIX } from '@personal-agent/protocol'

export { LOG_LEVELS, LOG_SOURCES, PYTHON_LOG_PREFIX }

export type LogLevel = (typeof LOG_LEVELS)[number]

export type LogSource = (typeof LOG_SOURCES)[number]

export type LogContext = Record<string, unknown>

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
}

export const LOG_LIMITS = {
  messageChars: 4096,
  stackChars: 8192,
  contextStringChars: 512,
  contextDepth: 4,
  contextArrayItems: 50,
  recordBytes: 32768,
  pythonStderrLineChars: 16384,
  pythonRawContextChars: 2048,
  normalizedMessageChars: 200,
  topFrameChars: 120
} as const

export interface LogRecord {
  schemaVersion: 1
  id: string
  ts: string
  level: LogLevel
  source: LogSource
  event: string
  code?: string
  message: string
  stack?: string
  fingerprint: string
  sessionId: string
  taskId?: string
  traceId?: string
  durationMs?: number
  context?: LogContext
}

export interface LogInput {
  level: LogLevel
  source: LogSource
  event: string
  message: string
  code?: string
  err?: unknown
  /** 显式堆栈优先于 err.stack：解析外部帧时堆栈是字符串，没有 Error 实例。 */
  stack?: string
  context?: LogContext
  taskId?: string
  traceId?: string
  durationMs?: number
}

export type LogInputWithoutLevel = Omit<LogInput, 'level'>

export interface LogSinkPort {
  append(record: LogRecord): void
  flush(): void
}
