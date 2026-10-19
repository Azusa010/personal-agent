import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { LogInput, LogLevel, LogSource } from '../../../src/main/observability/log-types'
import {
  buildLogRecord,
  computeFingerprint,
  normalizeMessage,
  serializeRecord,
  topFrame
} from '../../../src/main/observability/log-record'
import { createClock, createIdFactory } from './support'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(
  __dirname,
  '../../../../../packages/protocol/fixtures/logging/fingerprint-cases.json'
)

interface FingerprintFixture {
  cases: Array<{
    name: string
    input: { source: string; event: string; code?: string; message: string; stack?: string }
    normalizedMessage: string
    topFrame: string | null
    expected: string
  }>
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as FingerprintFixture
const byName = (name: string): FingerprintFixture['cases'][number] => {
  const found = fixture.cases.find((item) => item.name === name)
  if (!found) throw new Error(`缺少 fixture case: ${name}`)
  return found
}

function deps(): {
  now: () => Date
  id: () => string
  sessionId: string
} {
  const clock = createClock('2026-10-19T13:29:33.123Z')
  return { now: clock.now, id: createIdFactory('rec'), sessionId: 'session-1' }
}

function baseInput(overrides: Partial<LogInput> = {}): LogInput {
  return {
    level: 'error' as LogLevel,
    source: 'main' as LogSource,
    event: 'tool.call.failed',
    message: 'tool call failed',
    ...overrides
  }
}

describe('log-record ~ 指纹算法（与 Python 共享 fixture）', () => {
  for (const item of fixture.cases) {
    it(`${item.name}: 指纹与 fixture 期望值一致`, () => {
      const fingerprint = computeFingerprint({
        source: item.input.source as LogSource,
        event: item.input.event,
        code: item.input.code,
        message: item.input.message,
        stack: item.input.stack
      })

      expect(fingerprint).toBe(item.expected)
    })

    it(`${item.name}: 归一化消息与顶层帧符合 fixture`, () => {
      expect(normalizeMessage(item.input.message)).toBe(item.normalizedMessage)
      expect(topFrame(item.input.stack)).toBe(item.topFrame)
    })
  }

  it('仅数字不同的消息归一后相同', () => {
    expect(normalizeMessage('tool call failed after 3 retries')).toBe(
      normalizeMessage('tool call failed after 7 retries')
    )
  })

  it('归一化保持 200 字符上限', () => {
    expect(normalizeMessage('a'.repeat(500)).length).toBe(200)
  })

  it('顶层帧剔除行号与列号', () => {
    const a = topFrame('Error: x\n    at run (C:\\app\\a.js:1:1)')
    const b = topFrame('Error: x\n    at run (C:\\app\\a.js:999:42)')

    expect(a).toBe('run@a.js')
    expect(a).toBe(b)
  })

  it('无 stack 或无 at 行时返回 null', () => {
    expect(topFrame(undefined)).toBeNull()
    expect(topFrame('')).toBeNull()
    expect(topFrame('Error: no frames here')).toBeNull()
  })
})

describe('log-record ~ buildLogRecord 契约', () => {
  it('event 为空白时抛错', () => {
    expect(() => buildLogRecord(baseInput({ event: '   ' }), deps())).toThrow(/event/)
  })

  it('level 非法时抛错', () => {
    expect(() =>
      buildLogRecord(baseInput({ level: 'warning' as unknown as LogLevel }), deps())
    ).toThrow(/level/)
  })

  it('从 Error 提取 message 与 stack', () => {
    const error = new Error('boom')

    const record = buildLogRecord(baseInput({ message: '', err: error }), deps())

    expect(record.message).toBe('boom')
    expect(record.stack).toContain('Error: boom')
  })

  it('显式 message 优先于 err.message', () => {
    const record = buildLogRecord(
      baseInput({ message: '显式描述', err: new Error('内部细节') }),
      deps()
    )

    expect(record.message).toBe('显式描述')
  })

  it('ts 由注入时钟生成 ISO 8601 UTC 串，id/sessionId 透传', () => {
    const clock = createClock('2026-10-19T05:06:07.890Z')

    const record = buildLogRecord(baseInput(), {
      now: clock.now,
      id: () => 'fixed-id',
      sessionId: 'session-xyz'
    })

    expect(record.ts).toBe('2026-10-19T05:06:07.890Z')
    expect(record.id).toBe('fixed-id')
    expect(record.sessionId).toBe('session-xyz')
    expect(record.schemaVersion).toBe(1)
  })

  it('未提供的可选字段不出现（而非 null）', () => {
    const record = buildLogRecord(baseInput(), deps()) as unknown as Record<string, unknown>

    expect('taskId' in record).toBe(false)
    expect('traceId' in record).toBe(false)
    expect('durationMs' in record).toBe(false)
    expect('context' in record).toBe(false)
    expect('stack' in record).toBe(false)
  })

  it('message 截断到 4096 且以省略号结尾', () => {
    const record = buildLogRecord(baseInput({ message: 'x'.repeat(5000) }), deps())

    expect(record.message).toHaveLength(4096)
    expect(record.message.endsWith('…')).toBe(true)
  })

  it('stack 截断到 8192 且以省略号结尾', () => {
    const record = buildLogRecord(baseInput({ stack: 'y'.repeat(9000) }), deps())

    expect(record.stack).toHaveLength(8192)
    expect(record.stack?.endsWith('…')).toBe(true)
  })

  it('消息与堆栈在入库前脱敏', () => {
    const record = buildLogRecord(
      baseInput({
        message: 'api_key=sk-abcdefghijklmnopqrstuvwx 调用失败 m3171470760@gmail.com',
        stack: 'Error: boom\n    at run (C:\\Users\\Azusama\\app.js:1:1)'
      }),
      deps()
    )

    expect(record.message).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(record.message).toContain('api_key=***')
    expect(record.message).toContain('<email>')
    expect(record.stack).toContain('C:\\Users\\<user>\\app.js')
  })

  it('source=python 时同样脱敏（不信任子进程）', () => {
    const record = buildLogRecord(
      baseInput({ source: 'python', message: 'token=ghp_1234567890abcdefghij' }),
      deps()
    )

    expect(record.message).toBe('token=***')
  })

  it('context 中的敏感值与超限数组同样被清洗', () => {
    const record = buildLogRecord(
      baseInput({
        context: {
          key: 'sk-abcdefghijklmnopqrstuvwx',
          list: Array.from({ length: 80 }, (_, i) => i)
        }
      }),
      deps()
    )

    expect(JSON.stringify(record.context)).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect((record.context?.list as number[]).length).toBe(50)
  })

  it('context 过大时整体丢弃并标记 truncated', () => {
    const huge: Record<string, unknown> = {}
    for (let i = 0; i < 200; i += 1) huge[`k${i}`] = 'z'.repeat(600)

    const record = buildLogRecord(baseInput({ context: huge }), deps())
    const serialized = serializeRecord(record)

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(32768)
    expect(record.context).toEqual({ truncated: true })
  })

  it('记录指纹与 computeFingerprint 对同一输入一致', () => {
    const input = baseInput({ message: 'tool call failed after 3 retries' })
    const record = buildLogRecord(input, deps())

    expect(record.fingerprint).toBe(
      computeFingerprint({
        source: input.source,
        event: input.event,
        code: input.code,
        message: input.message,
        stack: record.stack
      })
    )
  })
})

describe('log-record ~ serializeRecord', () => {
  it('输出单行 JSON 且可反序列化', () => {
    const record = buildLogRecord(
      baseInput({ message: 'line1\nline2', stack: 'Error: a\n    at b (c.js:1:1)' }),
      deps()
    )

    const serialized = serializeRecord(record)

    expect(serialized.includes('\n')).toBe(false)
    expect(serialized.trim()).toBe(serialized)
    expect(JSON.parse(serialized)).toEqual(record)
  })

  it('常规记录远低于 32KiB 上限', () => {
    const serialized = serializeRecord(buildLogRecord(baseInput(), deps()))

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(32768)
  })
})

describe('log-record ~ fixture 关系断言', () => {
  it('同源变体共享指纹，异源事件分裂', () => {
    expect(byName('retry-count-variant-a').expected).toBe(byName('retry-count-variant-b').expected)
    expect(byName('uuid-a').expected).toBe(byName('uuid-b').expected)
    expect(byName('different-event').expected).not.toBe(byName('uuid-a').expected)
  })
})
