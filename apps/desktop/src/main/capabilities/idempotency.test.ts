import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ToolExecutionRecord } from '../../shared/domain'
import { fingerprintArguments } from '../permission/args-hash'
import type { BoundArgs } from '../policy/argument-binders'
import { idempotencyKey, resolveExecution } from './idempotency'
import { toPosix } from './roots'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-idem-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function p(...segs: string[]): string {
  return toPosix(join(dir, ...segs))
}

/** 造一条 attempting 记录喂给 resolver。capability/sourcePaths/targetPath 由各测试指定，
 *  其余字段是判定用不到的固定值。status 固定 attempting——resolver 只处理执行前的悬挂记录。
 */
function record(
  capability: string,
  sourcePaths: string[],
  targetPath: string | null
): ToolExecutionRecord {
  return {
    idempotencyKey: `${capability}:deadbeef`,
    taskId: 't-1',
    toolCallId: 'call-1',
    capability,
    argsHash: 'deadbeef',
    sourcePaths,
    targetPath,
    status: 'attempting',
    attemptedAt: '2026-09-14T00:00:00.000Z',
    finishedAt: null,
    resultPayload: null
  }
}

describe('idempotencyKey：内容派生的稳定键', () => {
  const bound: BoundArgs = {
    args: { source: 'a.pdf', target: 'Reading/a.pdf' },
    paths: { source: '/root/downloads/a.pdf', target: '/root/reading/Reading/a.pdf' }
  }

  it('格式是 taskId:capability:argsHash', () => {
    expect(idempotencyKey('task-1', 'filesystem_move', bound)).toBe(
      `task-1:filesystem_move:${fingerprintArguments(bound).hash}`
    )
  })

  it('同任务同能力同参数 → 同 key（跨调用稳定）', () => {
    expect(idempotencyKey('task-1', 'filesystem_move', bound)).toBe(
      idempotencyKey('task-1', 'filesystem_move', bound)
    )
  })

  it('不同能力 → 不同 key（参数相同也区分）', () => {
    expect(idempotencyKey('task-1', 'filesystem_move', bound)).not.toBe(
      idempotencyKey('task-1', 'filesystem_create_dir', bound)
    )
  })

  it('不同任务 → 不同 key：参数一模一样也不是同一件事', () => {
    // tool_executions 的主键就是这把键。不带 taskId 的话，第二个任务（同一份文件、
    // 同一个目标）会在 INSERT 上撞主键，或者命中上一个任务的登记被静默跳过。
    expect(idempotencyKey('task-1', 'filesystem_move', bound)).not.toBe(
      idempotencyKey('task-2', 'filesystem_move', bound)
    )
  })

  it('不同参数 → 不同 key', () => {
    const other: BoundArgs = {
      args: { source: 'b.pdf' },
      paths: { source: '/root/downloads/b.pdf' }
    }
    expect(idempotencyKey('task-1', 'filesystem_move', bound)).not.toBe(
      idempotencyKey('task-1', 'filesystem_move', other)
    )
  })
})

describe('resolveExecution：filesystem_move 的存在性判定', () => {
  it('source 不在、target 在 → done（rename 已发生）', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    await mkdir(p('Reading'), { recursive: true })
    await writeFile(target, 'MOVED')

    const verdict = await resolveExecution(record('filesystem_move', [source], target))
    expect(verdict.kind).toBe('done')
  })

  it('source 在、target 不在 → not-done（rename 没发生）', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    await mkdir(p('Reading'), { recursive: true })
    await writeFile(source, 'ORIGINAL')

    const verdict = await resolveExecution(record('filesystem_move', [source], target))
    expect(verdict.kind).toBe('not-done')
  })

  it('source 在、target 也在 → unknown（矛盾态）', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    await mkdir(p('Reading'), { recursive: true })
    await writeFile(source, 'ORIGINAL')
    await writeFile(target, 'OTHER')

    const verdict = await resolveExecution(record('filesystem_move', [source], target))
    expect(verdict.kind).toBe('unknown')
  })

  it('source 不在、target 也不在 → unknown（文件凭空消失）', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    await mkdir(p('Reading'), { recursive: true })

    const verdict = await resolveExecution(record('filesystem_move', [source], target))
    expect(verdict.kind).toBe('unknown')
  })

  it('sourcePaths 为空 → unknown（数据异常）', async () => {
    const verdict = await resolveExecution(record('filesystem_move', [], p('Reading', 'a.pdf')))
    expect(verdict.kind).toBe('unknown')
  })
})

describe('resolveExecution：filesystem_create_dir 的判定', () => {
  it('target 已是目录 → done', async () => {
    const target = p('Reading')
    await mkdir(target, { recursive: true })

    const verdict = await resolveExecution(record('filesystem_create_dir', [], target))
    expect(verdict.kind).toBe('done')
  })

  it('target 不存在 → not-done', async () => {
    const verdict = await resolveExecution(record('filesystem_create_dir', [], p('Reading')))
    expect(verdict.kind).toBe('not-done')
  })

  it('target 是同名文件不是目录 → unknown', async () => {
    const target = p('Reading')
    await writeFile(target, 'i-am-a-file')

    const verdict = await resolveExecution(record('filesystem_create_dir', [], target))
    expect(verdict.kind).toBe('unknown')
  })

  it('targetPath 为 null → unknown（数据异常）', async () => {
    const verdict = await resolveExecution(record('filesystem_create_dir', [], null))
    expect(verdict.kind).toBe('unknown')
  })
})

describe('resolveExecution：能力分发', () => {
  it('没有恢复判定的能力 → unknown', async () => {
    const verdict = await resolveExecution(record('some.other_capability', [], null))
    expect(verdict.kind).toBe('unknown')
  })
})
