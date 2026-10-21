import { LOG_LEVEL_RANK, type LogLevel, type LogRecord, type LogSource } from './log-types'

export interface LogGroup {
  fingerprint: string
  level: LogLevel
  source: LogSource
  event: string
  message: string
  count: number
  firstTs: string
  lastTs: string
  sampleId: string
  taskId?: string
}

export interface GroupOptions {
  minLevel?: LogLevel
}

const DEFAULT_MIN_LEVEL: LogLevel = 'error'

export function groupRecords(
  records: ReadonlyArray<LogRecord>,
  options: GroupOptions = {}
): LogGroup[] {
  const minLevel = options.minLevel === undefined ? DEFAULT_MIN_LEVEL : options.minLevel
  const threshold = LOG_LEVEL_RANK[minLevel]
  const groups = new Map<string, LogGroup>()

  for (const record of records) {
    if (LOG_LEVEL_RANK[record.level] < threshold) continue

    const existing = groups.get(record.fingerprint)
    if (existing === undefined) {
      groups.set(record.fingerprint, {
        fingerprint: record.fingerprint,
        level: record.level,
        source: record.source,
        event: record.event,
        message: record.message,
        count: 1,
        firstTs: record.ts,
        lastTs: record.ts,
        sampleId: record.id,
        ...(record.taskId === undefined ? {} : { taskId: record.taskId })
      })
      continue
    }

    existing.count += 1
    if (record.ts < existing.firstTs) existing.firstTs = record.ts

    if (record.ts >= existing.lastTs) {
      existing.lastTs = record.ts
      existing.level = record.level
      existing.source = record.source
      existing.event = record.event
      existing.message = record.message
      existing.sampleId = record.id
      if (record.taskId !== undefined) existing.taskId = record.taskId
    }
  }

  return [...groups.values()].sort((left, right) => {
    if (left.lastTs !== right.lastTs) return left.lastTs < right.lastTs ? 1 : -1
    return right.count - left.count
  })
}
