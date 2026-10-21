import { createHash, randomUUID } from 'node:crypto'

import { LOG_LEVELS, LOG_LIMITS, type LogInput, type LogRecord, type LogSource } from './log-types'
import { redactText, sanitizeContext, truncateText } from './redactor'

export interface BuildRecordDeps {
  now?: () => Date
  id?: () => string
  sessionId: string
  redact?: boolean
}

export interface FingerprintInput {
  source: LogSource
  event: string
  code?: string
  message: string
  stack?: string
}

const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
const TIMESTAMP_PATTERN = /[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z?/g
const HEX_PATTERN = /0x[0-9a-fA-F]+/g
const NUMBER_PATTERN = /[0-9]+(\.[0-9]+)?/g
const SPACE_PATTERN = /\s+/g
const FRAME_PATTERN = /^\s*at\s+(.+)$/
const NAMED_FRAME_PATTERN = /^(.+?)\s*\((.+)\)$/
const LOCATION_SUFFIX_PATTERN = /:[0-9]+(?::[0-9]+)?$/
const PATH_SEPARATOR_PATTERN = /[\\/]/

function collapse(text: string): string {
  return text.replace(SPACE_PATTERN, ' ').trim()
}

export function normalizeMessage(message: string): string {
  let output = message.trim()
  output = output.replace(UUID_PATTERN, '<uuid>')
  output = output.replace(TIMESTAMP_PATTERN, '<ts>')
  output = output.replace(HEX_PATTERN, '<hex>')
  output = output.replace(NUMBER_PATTERN, '<n>')
  output = collapse(output)
  return output.slice(0, LOG_LIMITS.normalizedMessageChars)
}

function basenameOf(target: string): string {
  const withoutLocation = target.trim().replace(LOCATION_SUFFIX_PATTERN, '')
  if (withoutLocation === '') return ''
  const segments = withoutLocation.split(PATH_SEPARATOR_PATTERN)
  return segments[segments.length - 1] ?? ''
}

function formatFrame(raw: string): string {
  const named = NAMED_FRAME_PATTERN.exec(raw)
  if (named !== null) {
    const name = collapse(named[1] ?? '')
    const base = basenameOf(named[2] ?? '')
    if (name !== '' && base !== '') return `${name}@${base}`
  }
  const base = basenameOf(raw)
  if (base !== '') return `@${base}`
  return collapse(raw).slice(0, LOG_LIMITS.topFrameChars)
}

export function topFrame(stack?: string): string | null {
  if (typeof stack !== 'string' || stack === '') return null
  for (const line of stack.split('\n')) {
    const matched = FRAME_PATTERN.exec(line)
    if (matched === null) continue
    const body = (matched[1] ?? '').trim()
    if (body === '') continue
    return formatFrame(body)
  }
  return null
}

export function computeFingerprint(input: FingerprintInput): string {
  const code = input.code === undefined || input.code === '' ? '-' : input.code
  const frame = topFrame(input.stack) ?? '-'
  const payload = [input.source, input.event, code, normalizeMessage(input.message), frame].join(
    '|'
  )
  return createHash('sha1').update(payload, 'utf8').digest('hex')
}

function byteLengthOf(record: LogRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

export function buildLogRecord(input: LogInput, deps: BuildRecordDeps): LogRecord {
  const event = typeof input.event === 'string' ? input.event.trim() : ''
  if (event === '') {
    throw new Error('buildLogRecord: event 不能为空')
  }
  if (!(LOG_LEVELS as readonly string[]).includes(input.level)) {
    throw new Error(`buildLogRecord: 非法 level ${String(input.level)}`)
  }

  const err = input.err instanceof Error ? input.err : undefined
  const rawMessage =
    input.message === undefined || input.message === '' ? (err?.message ?? '') : input.message
  const rawStack = input.stack === undefined ? err?.stack : input.stack
  const shouldRedact = deps.redact !== false

  const message = truncateText(
    shouldRedact ? redactText(rawMessage) : rawMessage,
    LOG_LIMITS.messageChars
  )
  const stack =
    rawStack === undefined
      ? undefined
      : truncateText(shouldRedact ? redactText(rawStack) : rawStack, LOG_LIMITS.stackChars)

  const record: LogRecord = {
    schemaVersion: 1,
    id: deps.id === undefined ? randomUUID() : deps.id(),
    ts: (deps.now === undefined ? new Date() : deps.now()).toISOString(),
    level: input.level,
    source: input.source,
    event,
    message,
    fingerprint: '',
    sessionId: deps.sessionId
  }

  if (input.code !== undefined && input.code !== '') record.code = input.code
  if (stack !== undefined) record.stack = stack
  if (input.taskId !== undefined) record.taskId = input.taskId
  if (input.traceId !== undefined) record.traceId = input.traceId
  if (input.durationMs !== undefined) record.durationMs = input.durationMs

  const context = shouldRedact ? sanitizeContext(input.context) : input.context
  if (context !== undefined) record.context = context

  record.fingerprint = computeFingerprint({
    source: record.source,
    event: record.event,
    code: record.code,
    message: record.message,
    stack: record.stack
  })

  if (record.context !== undefined && byteLengthOf(record) > LOG_LIMITS.recordBytes) {
    record.context = { truncated: true }
  }

  return record
}

export function serializeRecord(record: LogRecord): string {
  const text = JSON.stringify(record)
  if (Buffer.byteLength(text, 'utf8') <= LOG_LIMITS.recordBytes) return text
  return JSON.stringify({ ...record, context: { truncated: true } })
}
