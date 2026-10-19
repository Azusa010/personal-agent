import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type { CrashGuardProcess } from '../../../src/main/observability/crash-guard'
import { installCrashGuard } from '../../../src/main/observability/crash-guard'
import { createTestLogger } from './support'

function fakeProcess(): EventEmitter & CrashGuardProcess {
  return new EventEmitter() as EventEmitter & CrashGuardProcess
}

describe('crash-guard ~ uncaughtException', () => {
  it('记为 fatal 并带完整堆栈', () => {
    const proc = fakeProcess()
    const exit = vi.fn()
    const { logger, sink } = createTestLogger()

    installCrashGuard({ logger, process: proc, exit })
    proc.emit('uncaughtException', new Error('boom'))

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0].level).toBe('fatal')
    expect(sink.records[0].event).toBe('process.uncaught_exception')
    expect(sink.records[0].message).toBe('boom')
    expect(sink.records[0].stack).toContain('Error: boom')
  })

  it('先落盘再退出，退出码为 1', () => {
    const proc = fakeProcess()
    const { logger, sink } = createTestLogger()
    const observedAtExit: number[] = []
    const exit = vi.fn((code: number) => {
      observedAtExit.push(sink.records.length)
      expect(code).toBe(1)
    })

    installCrashGuard({ logger, process: proc, exit })
    proc.emit('uncaughtException', new Error('boom'))

    expect(exit).toHaveBeenCalledTimes(1)
    expect(observedAtExit).toEqual([1])
    expect(sink.flushCount).toBeGreaterThanOrEqual(1)
  })

  it('非 Error 的抛出物也能记录', () => {
    const proc = fakeProcess()
    const { logger, sink } = createTestLogger()

    installCrashGuard({ logger, process: proc, exit: vi.fn() })
    proc.emit('uncaughtException', 'string thrown')

    expect(sink.records[0].level).toBe('fatal')
    expect(sink.records[0].message).toContain('string thrown')
  })
})

describe('crash-guard ~ unhandledRejection', () => {
  it('记为 error 且不退出进程', () => {
    const proc = fakeProcess()
    const exit = vi.fn()
    const { logger, sink } = createTestLogger()

    installCrashGuard({ logger, process: proc, exit })
    proc.emit('unhandledRejection', new Error('rejected'))

    expect(sink.records[0].level).toBe('error')
    expect(sink.records[0].event).toBe('process.unhandled_rejection')
    expect(sink.records[0].message).toBe('rejected')
    expect(exit).not.toHaveBeenCalled()
  })

  it('字符串 reason 不被当成 Error 序列化', () => {
    const proc = fakeProcess()
    const { logger, sink } = createTestLogger()

    installCrashGuard({ logger, process: proc, exit: vi.fn() })
    proc.emit('unhandledRejection', 'just a string')

    expect(sink.records[0].message).toContain('just a string')
  })
})

describe('crash-guard ~ beforeExit', () => {
  it('记为 info 并刷盘', () => {
    const proc = fakeProcess()
    const exit = vi.fn()
    const { logger, sink } = createTestLogger()

    installCrashGuard({ logger, process: proc, exit })
    proc.emit('beforeExit', 0)

    expect(sink.records[0].level).toBe('info')
    expect(sink.records[0].event).toBe('process.before_exit')
    expect(sink.flushCount).toBeGreaterThanOrEqual(1)
    expect(exit).not.toHaveBeenCalled()
  })
})

describe('crash-guard ~ 卸载', () => {
  it('卸载后不再记录也不再退出', () => {
    const proc = fakeProcess()
    const exit = vi.fn()
    const { logger, sink } = createTestLogger()

    const uninstall = installCrashGuard({ logger, process: proc, exit })
    uninstall()
    proc.emit('uncaughtException', new Error('late'))

    expect(sink.records).toHaveLength(0)
    expect(exit).not.toHaveBeenCalled()
  })

  it('重复安装不会重复记录', () => {
    const proc = fakeProcess()
    const { logger, sink } = createTestLogger()

    installCrashGuard({ logger, process: proc, exit: vi.fn() })
    installCrashGuard({ logger, process: proc, exit: vi.fn() })
    proc.emit('uncaughtException', new Error('once'))

    expect(sink.records).toHaveLength(1)
  })
})
