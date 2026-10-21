import { describe, expect, it, vi } from 'vitest'

import { installConsoleBridge } from '../../../src/main/observability/console-bridge'
import { createTestLogger } from './support'

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>

function fakeConsole(): ConsoleLike {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}

describe('console-bridge ~ 级别映射', () => {
  it('console.error 记为 error 且保留原输出', () => {
    const target = fakeConsole()
    const original = target.error
    const { logger, sink } = createTestLogger()
    installConsoleBridge(logger, target)

    target.error('无法读取配置')

    expect(original).toHaveBeenCalledTimes(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0].level).toBe('error')
    expect(sink.records[0].source).toBe('main')
    expect(sink.records[0].event).toBe('console.error')
    expect(sink.records[0].message).toContain('无法读取配置')
  })

  it('warn / log / info / debug 各自映射', () => {
    const target = fakeConsole()
    const { logger, sink } = createTestLogger({ minLevel: 'debug' })
    installConsoleBridge(logger, target)

    target.warn('w')
    target.log('l')
    target.info('i')
    target.debug('d')

    expect(sink.records.map((r) => r.level)).toEqual(['warn', 'info', 'info', 'debug'])
    expect(sink.records.map((r) => r.event)).toEqual([
      'console.warn',
      'console.log',
      'console.info',
      'console.debug'
    ])
  })

  it('多参数合并成一条消息，不丢非字符串实参', () => {
    const target = fakeConsole()
    const { logger, sink } = createTestLogger()
    installConsoleBridge(logger, target)

    target.error('任务失败', 42, { taskId: 't-1' })

    expect(sink.records[0].message).toContain('任务失败')
    expect(sink.records[0].message).toContain('42')
    expect(sink.records[0].message).toContain('t-1')
  })

  it('Error 实参的堆栈被采集', () => {
    const target = fakeConsole()
    const { logger, sink } = createTestLogger()
    installConsoleBridge(logger, target)

    target.error('包装描述', new Error('inner boom'))

    expect(sink.records[0].message).toContain('包装描述')
    expect(sink.records[0].message).toContain('inner boom')
    expect(sink.records[0].stack).toContain('Error: inner boom')
  })

  it('循环引用实参不让桥接崩溃', () => {
    const target = fakeConsole()
    const { logger, sink } = createTestLogger()
    installConsoleBridge(logger, target)
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic

    expect(() => target.error('循环', cyclic)).not.toThrow()
    expect(sink.records).toHaveLength(1)
  })
})

describe('console-bridge ~ 幂等与卸载', () => {
  it('重复安装不会重复记录', () => {
    const target = fakeConsole()
    const { logger, sink } = createTestLogger()

    installConsoleBridge(logger, target)
    installConsoleBridge(logger, target)
    target.error('只应记一次')

    expect(sink.records).toHaveLength(1)
  })

  it('卸载后恢复原函数且不再记录', () => {
    const target = fakeConsole()
    const original = target.error
    const { logger, sink } = createTestLogger()

    const uninstall = installConsoleBridge(logger, target)
    target.error('before')
    uninstall()

    expect(target.error).toBe(original)

    target.error('after')

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0].message).toContain('before')
  })

  it('卸载后原函数仍然被调用', () => {
    const target = fakeConsole()
    const { logger } = createTestLogger()

    const uninstall = installConsoleBridge(logger, target)
    uninstall()
    target.warn('still works')

    expect(target.warn).toHaveBeenCalledWith('still works')
  })
})
