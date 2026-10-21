import type { LogLevel } from './log-types'
import type { Logger } from './logger'

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

export type ConsoleLike = Pick<Console, ConsoleMethod>

const METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug']

const LEVEL_BY_METHOD: Record<ConsoleMethod, LogLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug'
}

const installed = new WeakMap<object, () => void>()

function formatArgument(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '<unserializable>'
  }
}

function record(logger: Logger, method: ConsoleMethod, args: unknown[]): void {
  try {
    const message = args.map(formatArgument).join(' ')
    const error = args.find((arg) => arg instanceof Error)
    logger.log({
      level: LEVEL_BY_METHOD[method],
      source: 'main',
      event: `console.${method}`,
      message: message === '' ? '(empty)' : message,
      ...(error === undefined ? {} : { err: error })
    })
  } catch {
    return
  }
}

export function installConsoleBridge(logger: Logger, target: ConsoleLike = console): () => void {
  const key = target as unknown as object
  const existing = installed.get(key)
  if (existing !== undefined) return existing

  const originals = new Map<ConsoleMethod, unknown>()
  const slots = target as unknown as Record<string, (...args: unknown[]) => void>

  for (const method of METHODS) {
    const original = slots[method]
    originals.set(method, original)
    if (typeof original !== 'function') continue

    slots[method] = (...args: unknown[]): void => {
      try {
        original.apply(target, args)
      } finally {
        record(logger, method, args)
      }
    }
  }

  const uninstall = (): void => {
    for (const method of METHODS) {
      const original = originals.get(method)
      if (typeof original === 'function') slots[method] = original as (...args: unknown[]) => void
    }
    installed.delete(key)
  }

  installed.set(key, uninstall)
  return uninstall
}
