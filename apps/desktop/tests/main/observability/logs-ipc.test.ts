import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { LogRecord } from '../../../src/main/observability/log-types'
import {
  LOGS_CHANNELS,
  clearLogs,
  exportLogs,
  groupLogs,
  listLogs
} from '../../../src/main/observability/logs-ipc'
import { createClock, makeRecord, MemoryFileSystem } from './support'

const DIR = join('/virtual', 'userData', 'logs')
const FP_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FP_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function seedDay(fs: MemoryFileSystem, day: string, records: ReturnType<typeof makeRecord>[]): void {
  fs.seed(DIR, `error-${day}.jsonl`, records.map((r) => `${JSON.stringify(r)}\n`).join(''))
}

function deps(fs: MemoryFileSystem, iso = '2026-10-19T12:00:00.000Z'): {
  store: MemoryFileSystem
  dir: string
  now: () => Date
} {
  return { store: fs, dir: DIR, now: createClock(iso).now }
}

describe('logs-ipc ~ 通道常量', () => {
  it('通道名沿用 personal-agent 前缀', () => {
    expect(LOGS_CHANNELS.list).toBe('personal-agent:logs:list')
    expect(LOGS_CHANNELS.groups).toBe('personal-agent:logs:groups')
    expect(LOGS_CHANNELS.export).toBe('personal-agent:logs:export')
    expect(LOGS_CHANNELS.clear).toBe('personal-agent:logs:clear')
    expect(LOGS_CHANNELS.openDir).toBe('personal-agent:logs:open-dir')
  })
})

describe('logs-ipc ~ list', () => {
  it('默认返回最近 100 条并按 ts 倒序', () => {
    const fs = new MemoryFileSystem()
    const records = Array.from({ length: 120 }, (_, i) =>
      makeRecord({
        id: `r-${i}`,
        ts: new Date(Date.UTC(2026, 9, 19, 0, 0, 0) + i * 1000).toISOString()
      })
    )
    seedDay(fs, '2026-10-19', records)

    const result = listLogs({}, deps(fs))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.records).toHaveLength(100)
    expect(result.records[0].id).toBe('r-119')
    expect(result.records[99].id).toBe('r-20')
  })

  it('limit 可下调，且仍取最新的那批', () => {
    const fs = new MemoryFileSystem()
    seedDay(fs, '2026-10-19', [
      makeRecord({ id: 'old', ts: '2026-10-19T01:00:00.000Z' }),
      makeRecord({ id: 'new', ts: '2026-10-19T09:00:00.000Z' })
    ])

    const result = listLogs({ limit: 1 }, deps(fs))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.records.map((r: LogRecord) => r.id)).toEqual(['new'])
  })

  it('非法 limit 返回 INVALID_ARGUMENT', () => {
    const fs = new MemoryFileSystem()

    for (const limit of [0, -1, 501, 'ten']) {
      const result = listLogs({ limit }, deps(fs))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('OBSERVABILITY_INVALID_ARGUMENT')
    }
  })

  it('非法 minLevel 返回 INVALID_ARGUMENT', () => {
    const fs = new MemoryFileSystem()

    const result = listLogs({ minLevel: 'warning' }, deps(fs))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('OBSERVABILITY_INVALID_ARGUMENT')
  })

  it('minLevel 与 source 过滤生效', () => {
    const fs = new MemoryFileSystem()
    seedDay(fs, '2026-10-19', [
      makeRecord({ id: 'i', level: 'info', source: 'main' }),
      makeRecord({ id: 'e', level: 'error', source: 'python' }),
      makeRecord({ id: 'f', level: 'fatal', source: 'python' })
    ])

    const onlyPython = listLogs({ source: 'python', minLevel: 'error' }, deps(fs))

    expect(onlyPython.ok).toBe(true)
    if (!onlyPython.ok) return
    expect(onlyPython.records.map((r: LogRecord) => r.id).sort()).toEqual(['e', 'f'])
  })

  it('损坏的 JSONL 行被跳过而不是整次读取失败', () => {
    const fs = new MemoryFileSystem()
    const valid = JSON.stringify(makeRecord({ id: 'ok' }))
    fs.seed(DIR, 'error-2026-10-19.jsonl', `${valid}\n{broken\n`)

    const result = listLogs({}, deps(fs))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.records.map((r: LogRecord) => r.id)).toEqual(['ok'])
  })

  it('读取失败返回 READ_FAILED', () => {
    const fs = new MemoryFileSystem()
    fs.seed(DIR, 'error-2026-10-19.jsonl', '')
    const broken: MemoryFileSystem = Object.assign(fs, {
      readFile: () => {
        throw new Error('EACCES')
      }
    })

    const result = listLogs({}, deps(broken))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('OBSERVABILITY_READ_FAILED')
  })
})

describe('logs-ipc ~ groups', () => {
  it('默认 error 级别、7 天窗口', () => {
    const fs = new MemoryFileSystem()
    seedDay(fs, '2026-10-19', [
      makeRecord({ id: 'a1', fingerprint: FP_A, ts: '2026-10-19T10:00:00.000Z' }),
      makeRecord({ id: 'a2', fingerprint: FP_A, ts: '2026-10-19T11:00:00.000Z' }),
      makeRecord({ id: 'b1', fingerprint: FP_B, ts: '2026-10-19T09:00:00.000Z', level: 'warn' }),
      makeRecord({ id: 'old', fingerprint: FP_B, ts: '2026-10-01T09:00:00.000Z' })
    ])

    const result = groupLogs({}, deps(fs))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].fingerprint).toBe(FP_A)
    expect(result.groups[0].count).toBe(2)
  })

  it('days 非法或越界返回 INVALID_ARGUMENT', () => {
    const fs = new MemoryFileSystem()

    for (const days of [0, 31, 'week']) {
      const result = groupLogs({ days }, deps(fs))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('OBSERVABILITY_INVALID_ARGUMENT')
    }
  })
})

describe('logs-ipc ~ export', () => {
  it('bundle 是 JSON 文本且含环境信息与聚合结果', () => {
    const fs = new MemoryFileSystem()
    seedDay(fs, '2026-10-19', [makeRecord({ id: 'a', fingerprint: FP_A })])

    const result = exportLogs({}, deps(fs))

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const bundle = JSON.parse(result.bundle) as {
      generatedAt: string
      dir: string
      groups: unknown[]
      records: unknown[]
      runtime: { platform: string; node: string }
    }

    expect(bundle.generatedAt).toBe('2026-10-19T12:00:00.000Z')
    expect(bundle.dir).toBe(DIR)
    expect(bundle.records).toHaveLength(1)
    expect(bundle.groups).toHaveLength(1)
    expect(bundle.runtime.platform).toBe(process.platform)
    expect(bundle.runtime.node).toBe(process.version)
  })

  it('读取失败返回 EXPORT_FAILED', () => {
    const fs = new MemoryFileSystem()
    fs.seed(DIR, 'error-2026-10-19.jsonl', '')
    const broken: MemoryFileSystem = Object.assign(fs, {
      readFile: () => {
        throw new Error('EIO')
      }
    })

    const result = exportLogs({}, deps(broken))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('OBSERVABILITY_EXPORT_FAILED')
  })
})

describe('logs-ipc ~ clear', () => {
  it('只删除 jsonl 分片，保留其它文件', () => {
    const fs = new MemoryFileSystem()
    seedDay(fs, '2026-10-19', [makeRecord({ id: 'a' })])
    seedDay(fs, '2026-10-18', [makeRecord({ id: 'b' })])
    fs.seed(DIR, 'personal-agent.db', 'not-a-log')

    const result = clearLogs(deps(fs))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deleted).toBe(2)
    expect(fs.listFiles()).toEqual(['personal-agent.db'])
  })

  it('空目录返回 deleted=0', () => {
    const fs = new MemoryFileSystem()

    const result = clearLogs(deps(fs))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deleted).toBe(0)
  })

  it('删除失败返回 CLEAR_FAILED', () => {
    const fs = new MemoryFileSystem()
    seedDay(fs, '2026-10-19', [makeRecord({ id: 'a' })])
    const broken: MemoryFileSystem = Object.assign(fs, {
      removeFile: () => {
        throw new Error('EPERM')
      }
    })

    const result = clearLogs(deps(broken))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('OBSERVABILITY_CLEAR_FAILED')
  })
})
