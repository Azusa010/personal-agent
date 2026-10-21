import { describe, expect, it, vi } from 'vitest'

import type { LogInput, LogRecord } from '../../../src/main/observability/log-types'
import { Logger } from '../../../src/main/observability/logger'
import { createClock, createIdFactory } from './support'

class FakeSink {
  readonly records: LogRecord[] = []
  flushCount = 0

  append(record: LogRecord): void {
    this.records.push(record)
  }

  flush(): void {
    this.flushCount += 1
  }
}

function newLogger(
  sink: FakeSink,
  options: {
    clock?: ReturnType<typeof createClock>
    minLevel?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
    ringSize?: number
    rateLimit?: { windowMs: number; maxPerFingerprint: number }
  } = {}
): Logger {
  const clock = options.clock ?? createClock()
  return new Logger({
    sink,
    now: clock.now,
    id: createIdFactory('log'),
    sessionId: 'session-1',
    ...(options.minLevel === undefined ? {} : { minLevel: options.minLevel }),
    ...(options.ringSize === undefined ? {} : { ringSize: options.ringSize }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit })
  })
}

function input(overrides: Partial<LogInput> = {}): LogInput {
  return {
    level: 'error',
    source: 'main',
    event: 'tool.call.failed',
    message: 'tool call failed',
    ...overrides
  }
}

describe('Logger ~ 级别过滤', () => {
  it('默认 info 级别下 debug 被丢弃且不构造记录', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)

    const record = logger.debug({ source: 'main', event: 'noise', message: 'detail' })

    expect(record).toBeNull()
    expect(sink.records).toHaveLength(0)
    expect(logger.recent()).toHaveLength(0)
  })

  it('info 及以上默认全部记录', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)

    logger.info({ source: 'main', event: 'a', message: 'a' })
    logger.warn({ source: 'main', event: 'b', message: 'b' })
    logger.error({ source: 'main', event: 'c', message: 'c' })
    logger.fatal({ source: 'main', event: 'd', message: 'd' })

    expect(sink.records.map((r) => r.level)).toEqual(['info', 'warn', 'error', 'fatal'])
  })

  it('setMinLevel 立即生效', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)

    expect(logger.debug({ source: 'main', event: 'a', message: 'a' })).toBeNull()

    logger.setMinLevel('debug')

    expect(logger.debug({ source: 'main', event: 'a', message: 'a' })).not.toBeNull()
  })
})

describe('Logger ~ 环形缓冲', () => {
  it('只保留最近 ringSize 条，超出淘汰最旧', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink, { ringSize: 3 })
    const clock = createClock()

    for (const event of ['a', 'b', 'c', 'd', 'e']) {
      clock.advance(10)
      logger.log(input({ event, message: event }))
    }

    expect(logger.recent().map((r: LogRecord) => r.event)).toEqual(['c', 'd', 'e'])
  })

  it('recent(limit) 返回最近 N 条，最新在末尾', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink, { ringSize: 10 })

    for (const event of ['a', 'b', 'c', 'd']) logger.log(input({ event, message: event }))

    expect(logger.recent(2).map((r: LogRecord) => r.event)).toEqual(['c', 'd'])
  })

  it('recent 返回副本，外部修改不影响内部状态', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)

    logger.log(input())
    const snapshot = logger.recent()
    snapshot.pop()

    expect(logger.recent()).toHaveLength(1)
  })
})

describe('Logger ~ flush 策略', () => {
  it('error 与 fatal 触发立即 flush', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)

    logger.error({ source: 'main', event: 'a', message: 'a' })
    logger.fatal({ source: 'main', event: 'b', message: 'b' })

    expect(sink.flushCount).toBe(2)
  })

  it('info 级不触发 flush', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)

    logger.info({ source: 'main', event: 'a', message: 'a' })

    expect(sink.flushCount).toBe(0)
  })
})

describe('Logger ~ 限流降采样', () => {
  const rateLimit = { windowMs: 60_000, maxPerFingerprint: 5 }

  it('窗口内超出阈值的记录被压掉并返回 null', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink, { rateLimit })

    const results = Array.from({ length: 8 }, () =>
      logger.error({ source: 'main', event: 'loop.failed', message: 'same' })
    )

    expect(results.filter((r) => r !== null)).toHaveLength(5)
    expect(sink.records).toHaveLength(5)
  })

  it('窗口结束后补发汇总记录，带 suppressed 计数', () => {
    const sink = new FakeSink()
    const clock = createClock()
    const logger = newLogger(sink, { rateLimit, clock })

    for (let i = 0; i < 8; i += 1) {
      clock.advance(100)
      logger.error({ source: 'main', event: 'loop.failed', message: 'same' })
    }

    clock.advance(60_000)
    logger.error({ source: 'main', event: 'loop.failed', message: 'same' })

    const summary = sink.records.find((r) => r.event === 'log.rate_limited')

    expect(summary).toBeDefined()
    expect(summary?.level).toBe('warn')
    expect(summary?.context?.suppressed).toBe(3)
  })

  it('不同指纹互不影响限流额度', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink, { rateLimit })

    for (let i = 0; i < 5; i += 1) {
      logger.error({ source: 'main', event: 'a.failed', message: 'a' })
    }
    const other = logger.error({ source: 'main', event: 'b.failed', message: 'b' })

    expect(other).not.toBeNull()
  })

  it('fatal 不受限流压制', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink, { rateLimit })

    const results = Array.from({ length: 10 }, () =>
      logger.fatal({ source: 'main', event: 'crash', message: 'same' })
    )

    expect(results.every((r) => r !== null)).toBe(true)
    expect(sink.records).toHaveLength(10)
  })
})

describe('Logger ~ 订阅', () => {
  it('订阅者收到新记录，退订后不再收到', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)
    const seen: string[] = []

    const unsubscribe = logger.subscribe((record: LogRecord) => seen.push(record.event))
    logger.log(input({ event: 'a' }))
    unsubscribe()
    logger.log(input({ event: 'b' }))

    expect(seen).toEqual(['a'])
  })

  it('被级别过滤掉的记录不推给订阅者', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)
    const listener = vi.fn()

    logger.subscribe(listener)
    logger.debug({ source: 'main', event: 'noise', message: 'noise' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('订阅者抛错不影响其他订阅者与落盘', () => {
    const sink = new FakeSink()
    const logger = newLogger(sink)
    const second = vi.fn()

    logger.subscribe(() => {
      throw new Error('listener boom')
    })
    logger.subscribe(second)

    expect(() => logger.log(input())).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
    expect(sink.records).toHaveLength(1)
  })
})
