import { basename, dirname, join } from 'node:path'

import type { LogLevel, LogRecord, LogSource } from '../../../src/main/observability/log-types'
import type { SinkFileSystem } from '../../../src/main/observability/jsonl-sink'
import { Logger } from '../../../src/main/observability/logger'
import type { LogStore } from '../../../src/main/observability/logs-ipc'

export interface TestClock {
  now: () => Date
  advance: (ms: number) => void
  set: (iso: string) => void
}

export function createClock(startIso = '2026-10-19T13:29:33.123Z'): TestClock {
  let current = new Date(startIso).getTime()
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms
    },
    set: (iso: string) => {
      current = new Date(iso).getTime()
    }
  }
}

export function createIdFactory(prefix = 'id'): () => string {
  let seq = 0
  return () => `${prefix}-${(seq += 1)}`
}

export interface RecordOverrides {
  id?: string
  ts?: string
  level?: LogLevel
  source?: LogSource
  event?: string
  code?: string
  message?: string
  stack?: string
  fingerprint?: string
  sessionId?: string
  taskId?: string
  traceId?: string
  durationMs?: number
  context?: Record<string, unknown>
}

export function makeRecord(overrides: RecordOverrides = {}): LogRecord {
  return {
    schemaVersion: 1,
    id: overrides.id ?? 'rec-1',
    ts: overrides.ts ?? '2026-10-19T13:29:33.123Z',
    level: overrides.level ?? 'error',
    source: overrides.source ?? 'main',
    event: overrides.event ?? 'tool.call.failed',
    ...(overrides.code === undefined ? { code: 'HOST_HANDLER_FAILED' } : { code: overrides.code }),
    message: overrides.message ?? 'tool call failed',
    ...(overrides.stack === undefined ? {} : { stack: overrides.stack }),
    fingerprint: overrides.fingerprint ?? '5547fcd84f52e0b0391ba871f039167be3253785',
    sessionId: overrides.sessionId ?? 'session-1',
    ...(overrides.taskId === undefined ? {} : { taskId: overrides.taskId }),
    ...(overrides.traceId === undefined ? {} : { traceId: overrides.traceId }),
    ...(overrides.durationMs === undefined ? {} : { durationMs: overrides.durationMs }),
    ...(overrides.context === undefined ? {} : { context: overrides.context })
  }
}

/**
 * 内存文件系统：同时满足 JsonlSink 的写端口与 logs-ipc 的读端口。
 * 测试严禁触碰真实磁盘，全部经由本实现。
 */
export class MemoryFileSystem implements SinkFileSystem, LogStore {  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly removed: string[] = []
  writeFails = false
  mkdirFails = false

  seed(dir: string, name: string, content: string): string {
    const full = join(dir, name)
    this.files.set(full, content)
    return full
  }

  mkdir(path: string): void {
    if (this.mkdirFails) throw new Error(`EACCES: mkdir ${path}`)
    this.dirs.add(path)
  }

  appendFile(path: string, data: string): void {
    if (this.writeFails) throw new Error(`ENOSPC: appendFile ${path}`)
    this.files.set(path, (this.files.get(path) ?? '') + data)
  }

  readdir(path: string): string[] {
    return [...this.files.keys()]
      .filter((full) => dirname(full) === path)
      .map((full) => basename(full))
  }

  stat(path: string): { size: number } {
    const content = this.files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return { size: Buffer.byteLength(content, 'utf8') }
  }

  unlink(path: string): void {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`)
    this.removed.push(path)
  }

  listFiles(): string[] {
    return [...this.files.keys()].map((full) => basename(full))
  }

  readFile(name: string): string {
    const full = [...this.files.keys()].find((key) => basename(key) === name)
    if (full === undefined) throw new Error(`ENOENT: ${name}`)
    return this.files.get(full) ?? ''
  }

  removeFile(name: string): void {
    const full = [...this.files.keys()].find((key) => basename(key) === name)
    if (full === undefined) throw new Error(`ENOENT: ${name}`)
    this.unlink(full)
  }
}

export class FakeSink {
  readonly records: LogRecord[] = []
  flushCount = 0

  append(record: LogRecord): void {
    this.records.push(record)
  }

  flush(): void {
    this.flushCount += 1
  }
}

export interface TestLogger {
  logger: Logger
  sink: FakeSink
  clock: TestClock
}

export function createTestLogger(
  options: {
    startIso?: string
    minLevel?: LogLevel
    ringSize?: number
    rateLimit?: { windowMs: number; maxPerFingerprint: number }
  } = {}
): TestLogger {
  const clock = createClock(options.startIso ?? '2026-10-19T13:29:33.123Z')
  const sink = new FakeSink()

  const logger = new Logger({
    sink,
    now: clock.now,
    id: createIdFactory('log'),
    sessionId: 'session-1',
    ...(options.minLevel === undefined ? {} : { minLevel: options.minLevel }),
    ...(options.ringSize === undefined ? {} : { ringSize: options.ringSize }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit })
  })

  return { logger, sink, clock }
}
