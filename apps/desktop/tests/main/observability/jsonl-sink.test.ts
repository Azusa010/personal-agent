import { basename, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { JsonlSink } from '../../../src/main/observability/jsonl-sink'
import { createClock, makeRecord, MemoryFileSystem } from './support'

const DIR = join('/virtual', 'userData', 'logs')

function newSink(
  fs: MemoryFileSystem,
  options: {
    clock?: ReturnType<typeof createClock>
    maxFileBytes?: number
    retentionDays?: number
    maxTotalBytes?: number
    onError?: (error: unknown) => void
  } = {}
): JsonlSink {
  return new JsonlSink({
    dir: DIR,
    fs,
    now: (options.clock ?? createClock('2026-10-19T03:00:00.000Z')).now,
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
    ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
    ...(options.onError === undefined ? {} : { onError: options.onError })
  })
}

function lines(fs: MemoryFileSystem, name: string): string[] {
  return fs
    .readFile(name)
    .split('\n')
    .filter((line) => line.length > 0)
}

describe('jsonl-sink ~ 落盘', () => {
  it('append 只入队，flush 才落盘', () => {
    const fs = new MemoryFileSystem()
    const sink = newSink(fs)

    sink.append(makeRecord({ id: 'a' }))

    expect(fs.files.size).toBe(0)

    sink.flush()

    expect(fs.listFiles()).toHaveLength(1)
    expect(lines(fs, 'error-2026-10-19.jsonl')).toHaveLength(1)
  })

  it('每行一条 JSON，字段与传入记录一致', () => {
    const fs = new MemoryFileSystem()
    const sink = newSink(fs)
    const record = makeRecord({ id: 'a', message: 'boom', taskId: 'task-1' })

    sink.append(record)
    sink.flush()

    const parsed = JSON.parse(lines(fs, 'error-2026-10-19.jsonl')[0])

    expect(parsed).toEqual(record)
  })

  it('flush 后按写入顺序保留记录', () => {
    const fs = new MemoryFileSystem()
    const sink = newSink(fs)

    for (const id of ['a', 'b', 'c']) sink.append(makeRecord({ id }))
    sink.flush()

    const ids = lines(fs, 'error-2026-10-19.jsonl').map((line) => JSON.parse(line).id)

    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('空队列 flush 不创建文件', () => {
    const fs = new MemoryFileSystem()

    newSink(fs).flush()

    expect(fs.files.size).toBe(0)
  })

  it('跨天切换分片文件名', () => {
    const fs = new MemoryFileSystem()
    const clock = createClock('2026-10-19T15:00:00.000Z')
    const sink = newSink(fs, { clock })

    sink.append(makeRecord({ id: 'a' }))
    sink.flush()

    clock.set('2026-10-20T15:00:00.000Z')
    sink.append(makeRecord({ id: 'b' }))
    sink.flush()

    expect(fs.listFiles().sort()).toEqual([
      'error-2026-10-19.jsonl',
      'error-2026-10-20.jsonl'
    ].sort())
  })

  it('pathFor 返回当日主分片路径', () => {
    const fs = new MemoryFileSystem()
    const sink = newSink(fs, { clock: createClock('2026-10-19T03:00:00.000Z') })

    expect(basename(sink.pathFor())).toBe('error-2026-10-19.jsonl')
    expect(basename(sink.pathFor('2026-01-02'))).toBe('error-2026-01-02.jsonl')
  })
})

describe('jsonl-sink ~ 轮转', () => {
  it('超过 maxFileBytes 切到序号分片', () => {
    const fs = new MemoryFileSystem()
    const sink = newSink(fs, { maxFileBytes: 200 })
    const record = makeRecord({ message: 'x'.repeat(300) })

    for (let i = 0; i < 3; i += 1) sink.append(record)
    sink.flush()

    const names = fs.listFiles().sort()

    expect(names).toEqual([
      'error-2026-10-19.1.jsonl',
      'error-2026-10-19.2.jsonl',
      'error-2026-10-19.jsonl'
    ].sort())
    for (const name of names) expect(lines(fs, name)).toHaveLength(1)
  })

  it('单条记录本身超上限时仍写入空文件（不死循环）', () => {
    const fs = new MemoryFileSystem()
    const sink = newSink(fs, { maxFileBytes: 10 })

    sink.append(makeRecord({ message: 'y'.repeat(500) }))
    sink.flush()

    expect(fs.listFiles()).toHaveLength(1)
    expect(lines(fs, 'error-2026-10-19.jsonl')).toHaveLength(1)
  })
})

describe('jsonl-sink ~ 保留策略', () => {
  it('prune 删除超出保留天数的分片，绝不动今天', () => {
    const fs = new MemoryFileSystem()
    const clock = createClock('2026-10-19T03:00:00.000Z')
    const sink = newSink(fs, { clock, retentionDays: 7 })

    fs.seed(DIR, 'error-2026-10-11.jsonl', '{}\n')
    fs.seed(DIR, 'error-2026-10-09.jsonl', '{}\n')
    fs.seed(DIR, 'error-2026-10-18.jsonl', '{}\n')
    fs.seed(DIR, 'error-2026-10-19.jsonl', '{}\n')
    fs.seed(DIR, 'personal-agent.db', 'not-a-log')

    const result = sink.prune()

    expect(result.deleted.sort()).toEqual(['error-2026-10-11.jsonl', 'error-2026-10-09.jsonl'].sort())
    expect(fs.listFiles().sort()).toEqual([
      'personal-agent.db',
      'error-2026-10-18.jsonl',
      'error-2026-10-19.jsonl'
    ].sort())
  })

  it('总量超上限时按日期升序删最旧，但保留今天', () => {
    const fs = new MemoryFileSystem()
    const clock = createClock('2026-10-19T03:00:00.000Z')
    const sink = newSink(fs, { clock, retentionDays: 30, maxTotalBytes: 100 })

    fs.seed(DIR, 'error-2026-10-17.jsonl', 'x'.repeat(60))
    fs.seed(DIR, 'error-2026-10-18.jsonl', 'x'.repeat(60))
    fs.seed(DIR, 'error-2026-10-19.jsonl', 'x'.repeat(60))

    sink.prune()

    expect(fs.listFiles()).toContain('error-2026-10-19.jsonl')
    expect(fs.listFiles()).not.toContain('error-2026-10-17.jsonl')
  })

  it('prune 遇到非法文件名直接忽略', () => {
    const fs = new MemoryFileSystem()
    const sink = newSink(fs, { retentionDays: 1 })

    fs.seed(DIR, 'random.txt', 'keep')
    fs.seed(DIR, 'error-2026-10-19.1.jsonl', '{}\n')

    const result = sink.prune()

    expect(result.deleted).toEqual([])
    expect(fs.listFiles()).toContain('random.txt')
  })
})

describe('jsonl-sink ~ fail-open', () => {
  it('写失败只回调 onError，不向调用方抛', () => {
    const fs = new MemoryFileSystem()
    const onError = vi.fn()
    const sink = newSink(fs, { onError })
    fs.writeFails = true

    expect(() => {
      sink.append(makeRecord())
      sink.flush()
    }).not.toThrow()

    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('mkdir 失败同样 fail-open', () => {
    const fs = new MemoryFileSystem()
    const onError = vi.fn()
    const sink = newSink(fs, { onError })
    fs.mkdirFails = true

    expect(() => {
      sink.append(makeRecord())
      sink.flush()
    }).not.toThrow()

    expect(onError).toHaveBeenCalled()
  })

  it('剔除失败后队列不重复写旧记录', () => {
    const fs = new MemoryFileSystem()
    const onError = vi.fn()
    const sink = newSink(fs, { onError })

    fs.writeFails = true
    sink.append(makeRecord({ id: 'a' }))
    sink.flush()

    fs.writeFails = false
    sink.append(makeRecord({ id: 'b' }))
    sink.flush()

    const ids = lines(fs, 'error-2026-10-19.jsonl').map((line) => JSON.parse(line).id)

    expect(ids).toEqual(['b'])
  })
})

describe('jsonl-sink ~ close', () => {
  it('close 幂等且刷出剩余队列', () => {
    const fs = new MemoryFileSystem()
    const sink = newSink(fs)

    sink.append(makeRecord({ id: 'a' }))
    sink.close()
    expect(() => sink.close()).not.toThrow()

    expect(lines(fs, 'error-2026-10-19.jsonl')).toHaveLength(1)
  })
})
