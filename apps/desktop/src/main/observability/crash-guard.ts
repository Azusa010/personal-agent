import type { Logger } from './logger'

export interface CrashGuardProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface CrashGuardOptions {
  logger: Logger
  process: CrashGuardProcess
  exit?: (code: number) => void
}

const installed = new WeakMap<object, () => void>()

function describe(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function installCrashGuard(options: CrashGuardOptions): () => void {
  const key = options.process as unknown as object
  const existing = installed.get(key)
  if (existing !== undefined) return existing

  const exit =
    options.exit === undefined ? (code: number): void => process.exit(code) : options.exit

  const onUncaught = (error: unknown): void => {
    try {
      options.logger.fatal({
        source: 'main',
        event: 'process.uncaught_exception',
        message: describe(error),
        err: error
      })
      options.logger.flush()
    } catch {
      /* 日志不得反噬进程 */
    } finally {
      exit(1)
    }
  }

  const onRejection = (reason: unknown): void => {
    try {
      options.logger.error({
        source: 'main',
        event: 'process.unhandled_rejection',
        message: describe(reason),
        ...(reason instanceof Error ? { err: reason } : {})
      })
    } catch {
      /* 同上 */
    }
  }

  const onBeforeExit = (code: unknown): void => {
    try {
      options.logger.info({
        source: 'main',
        event: 'process.before_exit',
        message: `进程即将退出 (code=${String(code)})`
      })
      options.logger.flush()
    } catch {
      /* 同上 */
    }
  }

  options.process.on('uncaughtException', onUncaught)
  options.process.on('unhandledRejection', onRejection)
  options.process.on('beforeExit', onBeforeExit)

  const uninstall = (): void => {
    options.process.removeListener('uncaughtException', onUncaught)
    options.process.removeListener('unhandledRejection', onRejection)
    options.process.removeListener('beforeExit', onBeforeExit)
    installed.delete(key)
  }

  installed.set(key, uninstall)
  return uninstall
}
