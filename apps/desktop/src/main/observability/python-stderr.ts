import { LOG_LEVELS, LOG_LIMITS, PYTHON_LOG_PREFIX, type LogLevel } from './log-types'
import { truncateText } from './redactor'
import type { Logger } from './logger'

export { PYTHON_LOG_PREFIX }

export interface PythonStderrParserOptions {
  logger: Logger
}

const TRACEBACK_START = 'Traceback (most recent call last):'
const FINGERPRINT_PATTERN = /^[0-9a-f]{40}$/
const RAW_WARN_PATTERN = /(?:Error|Exception|Traceback)/
const LEADING_SPACE_PATTERN = /^\s/
const TRAILING_CR_PATTERN = /\r$/

function isLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class PythonStderrParser {
  private readonly logger: Logger
  private buffer = ''
  private traceback: string[] = []

  constructor(options: PythonStderrParserOptions) {
    this.logger = options.logger
  }

  push(chunk: string): void {
    this.buffer += chunk
    let boundary = this.buffer.indexOf('\n')
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 1)
      this.consume(line)
      boundary = this.buffer.indexOf('\n')
    }
  }

  flush(): void {
    if (this.buffer !== '') {
      const rest = this.buffer
      this.buffer = ''
      this.consume(rest)
    }
    this.drainTraceback()
  }

  private consume(line: string): void {
    const text = line.replace(TRAILING_CR_PATTERN, '')

    if (text.startsWith(PYTHON_LOG_PREFIX)) {
      this.drainTraceback()
      this.consumeFrame(text.slice(PYTHON_LOG_PREFIX.length))
      return
    }

    if (text.startsWith(TRACEBACK_START)) {
      this.drainTraceback()
      this.traceback = [text]
      return
    }

    if (this.traceback.length > 0) {
      this.traceback.push(text)
      if (this.endsTraceback(text)) this.drainTraceback()
      return
    }

    if (text.trim() === '') return
    this.consumeRaw(text)
  }

  private endsTraceback(line: string): boolean {
    if (line === '') return false
    return !LEADING_SPACE_PATTERN.test(line)
  }

  private drainTraceback(): void {
    if (this.traceback.length === 0) return
    const lines = this.traceback
    this.traceback = []
    const head = lines[0] ?? ''
    const tail = lines[lines.length - 1] ?? head
    try {
      this.logger.error({
        source: 'python',
        event: 'python.stderr.traceback',
        message: tail === head ? head : tail,
        stack: lines.join('\n')
      })
    } catch {
      /* 日志不得反噬 */
    }
  }

  private consumeRaw(text: string): void {
    const level: LogLevel = RAW_WARN_PATTERN.test(text) ? 'warn' : 'info'
    try {
      this.logger.log({
        level,
        source: 'python',
        event: 'python.stderr.raw',
        message: truncateText(text, LOG_LIMITS.pythonStderrLineChars)
      })
    } catch {
      /* 同上 */
    }
  }

  private consumeFrame(payload: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      this.logUnparsed(payload)
      return
    }

    if (!isRecord(parsed)) {
      this.logUnparsed(payload)
      return
    }

    const frame = parsed
    if (!isLevel(frame.level) || typeof frame.message !== 'string') {
      this.logUnparsed(payload)
      return
    }
    if (typeof frame.event !== 'string' || frame.event === '') {
      this.logUnparsed(payload)
      return
    }
    if (typeof frame.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(frame.fingerprint)) {
      this.logUnparsed(payload)
      return
    }

    try {
      this.logger.log({
        level: frame.level,
        source: 'python',
        event: frame.event,
        message: frame.message,
        ...(typeof frame.code === 'string' ? { code: frame.code } : {}),
        ...(typeof frame.stack === 'string' ? { stack: frame.stack } : {}),
        ...(typeof frame.taskId === 'string' ? { taskId: frame.taskId } : {}),
        ...(typeof frame.traceId === 'string' ? { traceId: frame.traceId } : {}),
        ...(typeof frame.durationMs === 'number' ? { durationMs: frame.durationMs } : {}),
        ...(isRecord(frame.context) ? { context: frame.context } : {})
      })
    } catch {
      /* 同上 */
    }
  }

  private logUnparsed(raw: string): void {
    try {
      this.logger.warn({
        source: 'python',
        event: 'python.log.unparsed',
        message: 'Python 日志帧解析失败',
        context: { raw: truncateText(raw, LOG_LIMITS.pythonRawContextChars) }
      })
    } catch {
      /* 同上 */
    }
  }
}
