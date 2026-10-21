import type { LogInput } from './log-types'
import type { Logger } from './logger'
import { PythonStderrParser } from './python-stderr'

let active: Logger | null = null

export function installAppLogger(logger: Logger): void {
  active = logger
}

export function getAppLogger(): Logger | null {
  return active
}

/** 各采集点统一入口：logger 未安装或写盘失败时静默失败，日志不得反噬业务。 */
export function logEvent(input: LogInput): void {
  const logger = active
  if (logger === null) return
  try {
    logger.log(input)
  } catch {
    return
  }
}

export function createStderrParser(): PythonStderrParser | null {
  const logger = active
  if (logger === null) return null
  return new PythonStderrParser({ logger })
}
