import {
  LOG_LEVELS,
  LOG_LEVEL_RANK,
  LOG_SOURCES,
  type LogLevel,
  type LogRecord,
  type LogSource
} from './log-types'
import { groupRecords, type LogGroup } from './aggregator'
import { OBSERVABILITY_ERROR_CODE } from './error-code'
import { parseLogDay } from './log-paths'

export const LOGS_CHANNELS = {
  list: 'personal-agent:logs:list',
  groups: 'personal-agent:logs:groups',
  export: 'personal-agent:logs:export',
  clear: 'personal-agent:logs:clear',
  openDir: 'personal-agent:logs:open-dir'
} as const

export interface LogStore {
  listFiles(): string[]
  readFile(name: string): string
  removeFile(name: string): void
}

export interface LogsIpcDeps {
  store: LogStore
  dir: string
  now?: () => Date
}

export interface LogsIpcFailure {
  ok: false
  code: string
  message: string
}

export type ListLogsResult = { ok: true; records: LogRecord[] } | LogsIpcFailure
export type GroupLogsResult = { ok: true; groups: LogGroup[] } | LogsIpcFailure
export type ExportLogsResult = { ok: true; bundle: string } | LogsIpcFailure
export type ClearLogsResult = { ok: true; deleted: number } | LogsIpcFailure

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500
const DEFAULT_GROUP_DAYS = 7
const MAX_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function failure(code: string, message: string): LogsIpcFailure {
  return { ok: false, code, message }
}

function isLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

function isSource(value: unknown): value is LogSource {
  return typeof value === 'string' && (LOG_SOURCES as readonly string[]).includes(value)
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseLine(line: string): LogRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const candidate = parsed as Partial<LogRecord>
  if (typeof candidate.ts !== 'string') return null
  if (typeof candidate.fingerprint !== 'string') return null
  if (typeof candidate.message !== 'string') return null
  if (!isLevel(candidate.level)) return null
  if (!isSource(candidate.source)) return null
  return candidate as LogRecord
}

function stampOf(record: LogRecord): number {
  const stamp = Date.parse(record.ts)
  return Number.isFinite(stamp) ? stamp : 0
}

function isAtLeast(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[threshold]
}

function readRecords(deps: LogsIpcDeps, days?: number): LogRecord[] {
  const now = deps.now === undefined ? new Date() : deps.now()
  const cutoff = days === undefined ? null : now.getTime() - days * DAY_MS
  const records: LogRecord[] = []

  for (const name of deps.store.listFiles()) {
    if (parseLogDay(name) === null) continue
    const content = deps.store.readFile(name)
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const record = parseLine(trimmed)
      if (record === null) continue
      if (cutoff !== null && stampOf(record) < cutoff) continue
      records.push(record)
    }
  }

  return records
}

export function listLogs(params: unknown, deps: LogsIpcDeps): ListLogsResult {
  const input = (params ?? {}) as Record<string, unknown>
  const limit = input.limit === undefined ? DEFAULT_LIST_LIMIT : input.limit
  if (!isBoundedInt(limit, 1, MAX_LIST_LIMIT)) {
    return failure(
      OBSERVABILITY_ERROR_CODE.INVALID_ARGUMENT,
      `limit 必须是 1..${MAX_LIST_LIMIT} 的整数`
    )
  }

  const minLevel = input.minLevel === undefined ? undefined : input.minLevel
  if (minLevel !== undefined && !isLevel(minLevel)) {
    return failure(OBSERVABILITY_ERROR_CODE.INVALID_ARGUMENT, 'minLevel 必须是合法级别')
  }

  const source = input.source === undefined ? undefined : input.source
  if (source !== undefined && !isSource(source)) {
    return failure(OBSERVABILITY_ERROR_CODE.INVALID_ARGUMENT, 'source 必须是合法来源')
  }

  let records: LogRecord[]
  try {
    records = readRecords(deps)
  } catch (error) {
    return failure(OBSERVABILITY_ERROR_CODE.READ_FAILED, messageOf(error))
  }

  const filtered = records.filter((record) => {
    if (minLevel !== undefined && !isAtLeast(record.level, minLevel)) return false
    if (source !== undefined && record.source !== source) return false
    return true
  })

  filtered.sort((left, right) => stampOf(right) - stampOf(left))

  return { ok: true, records: filtered.slice(0, limit) }
}

export function groupLogs(params: unknown, deps: LogsIpcDeps): GroupLogsResult {
  const input = (params ?? {}) as Record<string, unknown>
  const days = input.days === undefined ? DEFAULT_GROUP_DAYS : input.days
  if (!isBoundedInt(days, 1, MAX_DAYS)) {
    return failure(OBSERVABILITY_ERROR_CODE.INVALID_ARGUMENT, `days 必须是 1..${MAX_DAYS} 的整数`)
  }

  const minLevel = input.minLevel === undefined ? 'error' : input.minLevel
  if (!isLevel(minLevel)) {
    return failure(OBSERVABILITY_ERROR_CODE.INVALID_ARGUMENT, 'minLevel 必须是合法级别')
  }

  let records: LogRecord[]
  try {
    records = readRecords(deps, days)
  } catch (error) {
    return failure(OBSERVABILITY_ERROR_CODE.READ_FAILED, messageOf(error))
  }

  return { ok: true, groups: groupRecords(records, { minLevel }) }
}

export function exportLogs(params: unknown, deps: LogsIpcDeps): ExportLogsResult {
  const input = (params ?? {}) as Record<string, unknown>
  const days = input.days === undefined ? DEFAULT_GROUP_DAYS : input.days
  if (!isBoundedInt(days, 1, MAX_DAYS)) {
    return failure(OBSERVABILITY_ERROR_CODE.INVALID_ARGUMENT, `days 必须是 1..${MAX_DAYS} 的整数`)
  }

  const now = deps.now === undefined ? new Date() : deps.now()

  let records: LogRecord[]
  try {
    records = readRecords({ ...deps, now: () => now }, days)
  } catch (error) {
    return failure(OBSERVABILITY_ERROR_CODE.EXPORT_FAILED, messageOf(error))
  }

  const bundle = {
    generatedAt: now.toISOString(),
    dir: deps.dir,
    runtime: {
      platform: process.platform,
      node: process.version
    },
    groups: groupRecords(records, { minLevel: 'error' }),
    records
  }

  return { ok: true, bundle: JSON.stringify(bundle, null, 2) }
}

export function clearLogs(deps: LogsIpcDeps): ClearLogsResult {
  let deleted = 0
  try {
    for (const name of deps.store.listFiles()) {
      if (parseLogDay(name) === null) continue
      deps.store.removeFile(name)
      deleted += 1
    }
  } catch (error) {
    return failure(OBSERVABILITY_ERROR_CODE.CLEAR_FAILED, messageOf(error))
  }
  return { ok: true, deleted }
}
