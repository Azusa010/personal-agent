import { randomUUID } from 'node:crypto'

import {
  LOG_LEVEL_RANK,
  type LogInput,
  type LogInputWithoutLevel,
  type LogLevel,
  type LogRecord,
  type LogSinkPort
} from './log-types'
import { buildLogRecord } from './log-record'

export interface RateLimitOptions {
  windowMs: number
  maxPerFingerprint: number
}

export interface LoggerOptions {
  sink: LogSinkPort
  now?: () => Date
  id?: () => string
  sessionId: string
  minLevel?: LogLevel
  ringSize?: number
  rateLimit?: RateLimitOptions
}

interface RateEntry {
  windowStart: number
  count: number
  suppressed: number
}

const DEFAULT_MIN_LEVEL: LogLevel = 'info'
const DEFAULT_RING_SIZE = 200
const DEFAULT_RATE_LIMIT: RateLimitOptions = { windowMs: 60000, maxPerFingerprint: 50 }

export class Logger {
  private readonly sink: LogSinkPort
  private readonly now: () => Date
  private readonly id: () => string
  private readonly sessionId: string
  private readonly ringSize: number
  private readonly rateLimit: RateLimitOptions
  private readonly listeners = new Set<(record: LogRecord) => void>()
  private readonly counters = new Map<string, RateEntry>()
  private ring: LogRecord[] = []
  private minLevel: LogLevel

  constructor(options: LoggerOptions) {
    this.sink = options.sink
    this.now = options.now === undefined ? () => new Date() : options.now
    this.id = options.id === undefined ? randomUUID : options.id
    this.sessionId = options.sessionId
    this.minLevel = options.minLevel === undefined ? DEFAULT_MIN_LEVEL : options.minLevel
    this.ringSize = options.ringSize === undefined ? DEFAULT_RING_SIZE : options.ringSize
    this.rateLimit = options.rateLimit === undefined ? DEFAULT_RATE_LIMIT : options.rateLimit
  }

  log(input: LogInput): LogRecord | null {
    if (LOG_LEVEL_RANK[input.level] < LOG_LEVEL_RANK[this.minLevel]) return null

    const record = buildLogRecord(input, {
      now: this.now,
      id: this.id,
      sessionId: this.sessionId
    })

    if (!this.admit(record)) return null

    this.emit(record)
    return record
  }

  debug(input: LogInputWithoutLevel): LogRecord | null {
    return this.log({ ...input, level: 'debug' })
  }

  info(input: LogInputWithoutLevel): LogRecord | null {
    return this.log({ ...input, level: 'info' })
  }

  warn(input: LogInputWithoutLevel): LogRecord | null {
    return this.log({ ...input, level: 'warn' })
  }

  error(input: LogInputWithoutLevel): LogRecord | null {
    return this.log({ ...input, level: 'error' })
  }

  fatal(input: LogInputWithoutLevel): LogRecord | null {
    return this.log({ ...input, level: 'fatal' })
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level
  }

  recent(limit?: number): LogRecord[] {
    const snapshot = [...this.ring]
    if (limit === undefined) return snapshot
    if (limit <= 0) return []
    return snapshot.slice(-limit)
  }

  subscribe(listener: (record: LogRecord) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  flush(): void {
    this.sink.flush()
  }

  private admit(record: LogRecord): boolean {
    if (record.level === 'fatal') return true

    const { windowMs, maxPerFingerprint } = this.rateLimit
    const stamp = this.now().getTime()
    const entry = this.counters.get(record.fingerprint)

    if (entry === undefined || stamp - entry.windowStart >= windowMs) {
      if (entry !== undefined && entry.suppressed > 0) {
        this.emit(this.buildSummary(record, entry.suppressed))
      }
      this.counters.set(record.fingerprint, { windowStart: stamp, count: 1, suppressed: 0 })
      return true
    }

    if (entry.count < maxPerFingerprint) {
      entry.count += 1
      return true
    }

    entry.suppressed += 1
    return false
  }

  private buildSummary(source: LogRecord, suppressed: number): LogRecord {
    return buildLogRecord(
      {
        level: 'warn',
        source: source.source,
        event: 'log.rate_limited',
        message: `同一错误在窗口内被压制 ${suppressed} 条`,
        context: {
          suppressed,
          fingerprint: source.fingerprint,
          event: source.event
        }
      },
      { now: this.now, id: this.id, sessionId: this.sessionId }
    )
  }

  private emit(record: LogRecord): void {
    this.ring.push(record)
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize)
    }

    this.sink.append(record)
    if (LOG_LEVEL_RANK[record.level] >= LOG_LEVEL_RANK.error) {
      this.sink.flush()
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(record)
      } catch {
        continue
      }
    }
  }
}
