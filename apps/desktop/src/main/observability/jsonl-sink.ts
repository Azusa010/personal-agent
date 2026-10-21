import { join } from 'node:path'

import type { LogRecord } from './log-types'
import { serializeRecord } from './log-record'
import { dayKey, logFileName, parseLogDay, rotatedFileName } from './log-paths'

export interface SinkFileSystem {
  mkdir(path: string): void
  appendFile(path: string, data: string): void
  readdir(path: string): string[]
  stat(path: string): { size: number }
  unlink(path: string): void
}

export interface JsonlSinkOptions {
  dir: string
  fs: SinkFileSystem
  now?: () => Date
  maxFileBytes?: number
  retentionDays?: number
  maxTotalBytes?: number
  onError?: (error: unknown) => void
}

interface ShardTarget {
  day: string
  seq: number
  size: number
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_RETENTION_DAYS = 7
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024

export class JsonlSink {
  private readonly dir: string
  private readonly fs: SinkFileSystem
  private readonly now: () => Date
  private readonly maxFileBytes: number
  private readonly retentionDays: number
  private readonly maxTotalBytes: number
  private readonly onError: ((error: unknown) => void) | undefined
  private queue: string[] = []
  private active: ShardTarget | null = null
  private directoryReady = false
  private closed = false

  constructor(options: JsonlSinkOptions) {
    this.dir = options.dir
    this.fs = options.fs
    this.now = options.now === undefined ? () => new Date() : options.now
    this.maxFileBytes =
      options.maxFileBytes === undefined ? DEFAULT_MAX_FILE_BYTES : options.maxFileBytes
    this.retentionDays =
      options.retentionDays === undefined ? DEFAULT_RETENTION_DAYS : options.retentionDays
    this.maxTotalBytes =
      options.maxTotalBytes === undefined ? DEFAULT_MAX_TOTAL_BYTES : options.maxTotalBytes
    this.onError = options.onError
  }

  append(record: LogRecord): void {
    if (this.closed) return
    this.queue.push(serializeRecord(record))
  }

  flush(): void {
    if (this.queue.length === 0) return

    const batch = this.queue
    this.queue = []

    try {
      if (!this.directoryReady) {
        this.fs.mkdir(this.dir)
        this.directoryReady = true
      }
    } catch (error) {
      this.report(error)
      return
    }

    for (const line of batch) {
      try {
        this.writeLine(line)
      } catch (error) {
        this.report(error)
      }
    }
  }

  pathFor(day?: string): string {
    return join(this.dir, logFileName(day === undefined ? dayKey(this.now()) : day))
  }

  prune(): { deleted: string[] } {
    const deleted: string[] = []

    let names: string[]
    try {
      names = this.fs.readdir(this.dir)
    } catch (error) {
      this.report(error)
      return { deleted }
    }

    const today = dayKey(this.now())
    const cutoff = this.cutoffDay()
    const shards: Array<{ name: string; day: string }> = []

    for (const name of names) {
      const day = parseLogDay(name)
      if (day === null) continue
      shards.push({ name, day })
    }

    for (const shard of shards) {
      if (shard.day >= cutoff || shard.day === today) continue
      if (this.remove(shard.name)) deleted.push(shard.name)
    }

    const survivors = shards
      .filter((shard) => !deleted.includes(shard.name))
      .map((shard) => ({
        name: shard.name,
        day: shard.day,
        size: this.sizeOf(join(this.dir, shard.name))
      }))
      .sort(
        (left, right) => left.day.localeCompare(right.day) || left.name.localeCompare(right.name)
      )

    let total = survivors.reduce((sum, shard) => sum + shard.size, 0)

    for (const shard of survivors) {
      if (total <= this.maxTotalBytes) break
      if (shard.day === today) continue
      if (!this.remove(shard.name)) continue
      deleted.push(shard.name)
      total -= shard.size
    }

    return { deleted }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.flush()
  }

  private writeLine(line: string): void {
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    const target = this.resolveTarget(bytes)
    this.fs.appendFile(target, `${line}\n`)
  }

  private resolveTarget(bytes: number): string {
    const day = dayKey(this.now())

    if (this.active === null || this.active.day !== day) {
      this.active = { day, seq: 0, size: this.sizeOf(this.shardPath(day, 0)) }
    }

    if (this.active.size > 0 && this.active.size + bytes > this.maxFileBytes) {
      let seq = this.active.seq + 1
      let size = this.sizeOf(this.shardPath(day, seq))
      while (size > 0 && size + bytes > this.maxFileBytes) {
        seq += 1
        size = this.sizeOf(this.shardPath(day, seq))
      }
      this.active = { day, seq, size }
    }

    this.active.size += bytes
    return this.shardPath(day, this.active.seq)
  }

  private shardPath(day: string, seq: number): string {
    return join(this.dir, seq === 0 ? logFileName(day) : rotatedFileName(day, seq))
  }

  private cutoffDay(): string {
    const now = this.now()
    const cutoff = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - (this.retentionDays - 1)
    )
    return dayKey(cutoff)
  }

  private sizeOf(path: string): number {
    try {
      return this.fs.stat(path).size
    } catch {
      return 0
    }
  }

  private remove(name: string): boolean {
    try {
      this.fs.unlink(join(this.dir, name))
      return true
    } catch (error) {
      this.report(error)
      return false
    }
  }

  private report(error: unknown): void {
    if (this.onError === undefined) return
    try {
      this.onError(error)
    } catch {
      return
    }
  }
}
