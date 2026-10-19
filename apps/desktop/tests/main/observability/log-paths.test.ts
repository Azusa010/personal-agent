import { describe, expect, it } from 'vitest'

import {
  LOG_DIR_NAME,
  dayKey,
  logFileName,
  parseLogDay,
  resolveLogDir,
  rotatedFileName
} from '../../../src/main/observability/log-paths'

describe('log-paths', () => {
  it('日志目录固定挂在 userData 下的 logs/', () => {
    expect(LOG_DIR_NAME).toBe('logs')

    const dir = resolveLogDir('C:\\Users\\bob\\AppData\\Roaming\\personal-agent')

    expect(dir.split(/[\\/]/).pop()).toBe('logs')
    expect(dir).toContain('personal-agent')
  })

  it('dayKey 取本地日期，跨零点切换分片', () => {
    expect(dayKey(new Date(2026, 9, 19, 0, 0, 0))).toBe('2026-10-19')
    expect(dayKey(new Date(2026, 9, 19, 23, 59, 59, 999))).toBe('2026-10-19')
    expect(dayKey(new Date(2026, 9, 20, 0, 0, 0))).toBe('2026-10-20')
    expect(dayKey(new Date(2026, 0, 1, 12, 0, 0))).toBe('2026-01-01')
  })

  it('文件名格式：当日主分片与轮转分片', () => {
    expect(logFileName('2026-10-19')).toBe('error-2026-10-19.jsonl')
    expect(rotatedFileName('2026-10-19', 1)).toBe('error-2026-10-19.1.jsonl')
    expect(rotatedFileName('2026-10-19', 12)).toBe('error-2026-10-19.12.jsonl')
  })

  it('parseLogDay 只认本系统文件名', () => {
    expect(parseLogDay('error-2026-10-19.jsonl')).toBe('2026-10-19')
    expect(parseLogDay('error-2026-10-19.3.jsonl')).toBe('2026-10-19')
    expect(parseLogDay('error-2026-10-19.txt')).toBeNull()
    expect(parseLogDay('personal-agent.db')).toBeNull()
    expect(parseLogDay('error-2026-10-19.jsonl.bak')).toBeNull()
    expect(parseLogDay('not-a-log.jsonl')).toBeNull()
  })

  it('parseLogDay 拒绝不存在的日期', () => {
    expect(parseLogDay('error-2026-13-01.jsonl')).toBeNull()
    expect(parseLogDay('error-2026-02-30.jsonl')).toBeNull()
    expect(parseLogDay('error-2026-00-10.jsonl')).toBeNull()
  })

  it('同一日期的主分片与轮转分片解析出同一个 day', () => {
    expect(parseLogDay(logFileName('2026-10-19'))).toBe(parseLogDay(rotatedFileName('2026-10-19', 2)))
  })
})
