import { describe, expect, it } from 'vitest'

import { PYTHON_LOG_PREFIX, PythonStderrParser } from '../../../src/main/observability/python-stderr'
import { createTestLogger } from './support'

function frame(payload: Record<string, unknown>): string {
  return `${PYTHON_LOG_PREFIX}${JSON.stringify(payload)}\n`
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'py-1',
    ts: '2026-10-19T13:29:33.123Z',
    level: 'error',
    source: 'python',
    event: 'tool.execute.failed',
    code: 'TERMINAL_EXECUTE_FAILED',
    message: '命令执行失败',
    fingerprint: '5547fcd84f52e0b0391ba871f039167be3253785',
    sessionId: 'session-1',
    taskId: 'task-9',
    ...overrides
  }
}

describe('python-stderr ~ 帧解析', () => {
  it('前缀常量与协议层一致', () => {
    expect(PYTHON_LOG_PREFIX).toBe('@@PALOG@@')
  })

  it('合法帧透传 level / event / code / taskId', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push(frame(validPayload()))
    parser.flush()

    expect(sink.records).toHaveLength(1)
    const record = sink.records[0]
    expect(record.source).toBe('python')
    expect(record.level).toBe('error')
    expect(record.event).toBe('tool.execute.failed')
    expect(record.code).toBe('TERMINAL_EXECUTE_FAILED')
    expect(record.message).toBe('命令执行失败')
    expect(record.taskId).toBe('task-9')
  })

  it('同一 chunk 内多个帧各自成条', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push(frame(validPayload({ id: 'a' })) + frame(validPayload({ id: 'b' })))

    expect(sink.records).toHaveLength(2)
  })

  it('跨 chunk 的半行被拼接，不截成两条', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })
    const line = frame(validPayload())
    const cut = 30

    parser.push(line.slice(0, cut))
    expect(sink.records).toHaveLength(0)

    parser.push(line.slice(cut))

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0].event).toBe('tool.execute.failed')
  })

  it('末尾无换行的帧在 flush 时补发', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push(frame(validPayload()).trimEnd())
    expect(sink.records).toHaveLength(0)

    parser.flush()

    expect(sink.records).toHaveLength(1)
  })
})

describe('python-stderr ~ 降级', () => {
  it('非法 JSON 降级为 warn 且保留原文', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push(`${PYTHON_LOG_PREFIX}{not-json\n`)

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0].level).toBe('warn')
    expect(sink.records[0].event).toBe('python.log.unparsed')
    expect(String(sink.records[0].context?.raw)).toContain('{not-json')
  })

  it('缺必填字段的帧同样降级', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })
    const incomplete = validPayload()
    delete incomplete.fingerprint

    parser.push(frame(incomplete))

    expect(sink.records[0].event).toBe('python.log.unparsed')
  })

  it('普通裸行记为 info 的 raw', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push('启动完成，端口已就绪\n')

    expect(sink.records[0].level).toBe('info')
    expect(sink.records[0].event).toBe('python.stderr.raw')
    expect(sink.records[0].source).toBe('python')
    expect(sink.records[0].message).toContain('启动完成')
  })

  it('含 Error 的裸行升级为 warn', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push('ValueError: bad input\n')

    expect(sink.records[0].level).toBe('warn')
    expect(sink.records[0].event).toBe('python.stderr.raw')
  })

  it('超长裸行截断到 16384', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push(`${'z'.repeat(20000)}\n`)

    expect(sink.records[0].message.length).toBeLessThanOrEqual(16384)
  })
})

describe('python-stderr ~ traceback', () => {
  it('多行 traceback 合并成一条 error', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push('Traceback (most recent call last):\n')
    parser.push('  File "app.py", line 10, in run\n')
    parser.push('    raise RuntimeError("boom")\n')
    parser.push('RuntimeError: boom\n')

    expect(sink.records).toHaveLength(1)
    const record = sink.records[0]
    expect(record.level).toBe('error')
    expect(record.event).toBe('python.stderr.traceback')
    expect(`${record.message}\n${record.stack ?? ''}`).toContain('RuntimeError: boom')
    expect(record.stack ?? '').toContain('File "app.py"')
  })

  it('traceback 之后的新裸行重新起条', () => {
    const { logger, sink } = createTestLogger()
    const parser = new PythonStderrParser({ logger })

    parser.push('Traceback (most recent call last):\n')
    parser.push('  File "app.py", line 1, in run\n')
    parser.push('RuntimeError: boom\n')
    parser.push('另一条独立日志\n')

    expect(sink.records).toHaveLength(2)
    expect(sink.records[1].event).toBe('python.stderr.raw')
  })
})
