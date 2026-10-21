/**
 * redactor.ts
 * 脱敏文件
 */

import { LOG_LIMITS } from './log-types'

export interface RedactionRule {
  readonly id: string
  readonly pattern: RegExp
  readonly replacement: string
}

export const REDACTION_RULES: ReadonlyArray<RedactionRule> = [
  {
    id: 'key-value',
    pattern:
      /((?:api_key|access_token|refresh_token|token|password|passwd|secret|authorization)[ \t]*[:=][ \t]*)(?:(?:Bearer|Basic|Token)[ \t]+)?(?:"[^"]*"|'[^']*'|[^\s,;)}\]])+/gi,
    replacement: '$1***'
  },
  {
    id: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: 'Bearer ***'
  },
  {
    id: 'platform-key',
    pattern: /(sk|pk)-[A-Za-z0-9_-]{16,}/g,
    replacement: '$1-***'
  },
  {
    id: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: '<email>'
  },
  {
    id: 'phone',
    pattern: /\b1[3-9][0-9]{9}\b/g,
    replacement: '<phone>'
  },
  {
    id: 'windows-user-dir',
    pattern: /([A-Za-z]:\\Users\\)[^\\\s"']+/g,
    replacement: '$1<user>'
  },
  {
    id: 'posix-home',
    pattern: /(\/home\/|\/Users\/)[^/\s"']+/g,
    replacement: '$1<user>'
  }
]

export function redactText(text: string): string {
  let output = text
  for (const rule of REDACTION_RULES) {
    output = output.replace(rule.pattern, rule.replacement)
  }
  return output
}

export function truncateText(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

const DEPTH_LIMIT = '<depth-limit>'
const CIRCULAR = '<circular>'
const UNSUPPORTED = '<unsupported>'

const SENSITIVE_KEYS = new Set([
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'token',
  'password',
  'passwd',
  'secret',
  'authorization',
  'credential',
  'credentials'
])

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function sanitizeError(error: Error): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: truncateText(redactText(error.name || 'Error'), LOG_LIMITS.contextStringChars),
    message: truncateText(redactText(error.message), LOG_LIMITS.contextStringChars)
  }
  if (typeof error.stack === 'string') {
    output.stack = truncateText(redactText(error.stack), LOG_LIMITS.stackChars)
  }
  return output
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string') {
    return truncateText(redactText(value as string), LOG_LIMITS.contextStringChars)
  }
  if (kind === 'number' || kind === 'boolean') return value
  if (kind === 'undefined') return UNSUPPORTED
  if (kind === 'bigint' || kind === 'symbol' || kind === 'function') return UNSUPPORTED
  if (value instanceof Error) return sanitizeError(value)
  if (value instanceof Date) return value.toISOString()
  if (kind !== 'object') return UNSUPPORTED

  const target = value as object
  if (seen.has(target)) return CIRCULAR
  if (depth + 1 > LOG_LIMITS.contextDepth) return DEPTH_LIMIT
  seen.add(target)

  if (Array.isArray(target)) {
    return target
      .slice(0, LOG_LIMITS.contextArrayItems)
      .map((item) => sanitizeValue(item, depth + 1, seen))
  }
  if (!isPlainObject(target)) return UNSUPPORTED

  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(target as Record<string, unknown>)) {
    if (child === undefined) continue
    if (SENSITIVE_KEYS.has(key.trim().toLowerCase())) {
      output[key] = '***'
      continue
    }
    output[key] = sanitizeValue(child, depth + 1, seen)
  }
  return output
}

export function sanitizeContext(
  context: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (context === undefined) return undefined
  const result = sanitizeValue(context, 0, new WeakSet<object>())
  if (result === null || typeof result !== 'object') return undefined
  return result as Record<string, unknown>
}
