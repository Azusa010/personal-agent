import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CapabilityDescriptor, HostExecuteToolParams } from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fingerprintArguments } from '../permission/args-hash'
import type { BoundArgs } from '../policy/argument-binders'
import { UI_ORIGIN, type AuthorizedCall, type PermissionGate } from '../policy/execution-policy'
import {
  MEMORY_DB,
  migrate,
  openProductState,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteTaskRepository } from '../product-state/task-repository'
import {
  SqliteToolExecutionRepository,
  type ToolExecutionRecord,
  type ToolExecutionStatus
} from '../product-state/tool-execution-repository'
import { createExecutor } from './executor'
import { afterExecute, beginAttempt, idempotencyKey, type IdempotencyDeps } from './idempotency'
import { RuleBasedToolRetriever } from './retriever'
import { toPosix } from './roots'
import type { TaskScope } from './scope'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'
const T0 = '2026-09-14T00:00:00.000Z'
const T1 = '2026-09-14T00:00:05.000Z'

let dir: string
let db: SqliteDatabase | null = null
let repo: SqliteToolExecutionRepository

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-idem-guard-'))
  vi.stubEnv(ENV_NAME, dir)
  db = openProductState(MEMORY_DB)
  migrate(db)
  new SqliteTaskRepository(db).insert({
    id: 't-1',
    goal: '整理下载目录',
    status: 'running',
    createdAt: T0,
    updatedAt: T0
  })
  repo = new SqliteToolExecutionRepository(db)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  db?.close()
  db = null
  await rm(dir, { recursive: true, force: true })
})

function deps(): IdempotencyDeps {
  return { executions: repo, now: () => T1 }
}

function p(...segs: string[]): string {
  return toPosix(join(dir, ...segs))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const MOVE_DESCRIPTOR: CapabilityDescriptor = {
  name: 'filesystem_move',
  kind: 'WRITE',
  description: '移动文件'
}

/** 造一个 move 的 AuthorizedCall。bound.paths 用 realpath 后的正斜杠形式，
 *  与 executor 内部 bindArguments 的产出一致，这样两边算出的 key 才对得上。
 */
function moveCall(source: string, target: string, callId = 'call-1'): AuthorizedCall {
  const bound: BoundArgs = {
    args: { source, target },
    paths: { source: toPosix(source), target: toPosix(target) }
  }
  return { callId, capability: MOVE_DESCRIPTOR, bound, taskId: 't-1' }
}

function moveKey(source: string, target: string): string {
  return idempotencyKey('t-1', 'filesystem_move', moveCall(source, target).bound)
}

/** 往 store 里塞一条已登记的执行记录，key 与 moveCall 算出的一致（beginAttempt 才命中得了）。
 *  模拟「上一次进程跑到一半崩了」留下的库状态。
 */
function seedExecution(
  source: string,
  target: string,
  status: ToolExecutionStatus,
  resultPayload: unknown = null
): ToolExecutionRecord {
  const record: ToolExecutionRecord = {
    idempotencyKey: moveKey(source, target),
    taskId: 't-1',
    toolCallId: 'call-crash',
    capability: 'filesystem_move',
    argsHash: fingerprintArguments(moveCall(source, target).bound).hash,
    sourcePaths: [toPosix(source)],
    targetPath: toPosix(target),
    status,
    attemptedAt: T0,
    finishedAt: status === 'attempting' ? null : T1,
    resultPayload
  }
  repo.insert(record)
  return record
}

describe('beginAttempt：执行前幂等决策', () => {
  it('从没登记过 → proceed，并 insert 一条 attempting', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')

    const decision = await beginAttempt(deps(), moveCall(source, target))

    expect(decision.kind).toBe('proceed')
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('attempting')
  })

  it('上次已 succeeded → skip，原样返回缓存的 resultPayload，不动 store', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    const cached = { ok: true, source: toPosix(source), target: toPosix(target) }
    seedExecution(source, target, 'succeeded', cached)

    const decision = await beginAttempt(deps(), moveCall(source, target))

    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') {
      expect(decision.result).toEqual(cached)
    }
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('succeeded')
  })

  it('崩在 attempting 但文件系统显示已做完（source 不在、target 在）→ skip + 翻 succeeded', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    await mkdir(p('Reading'), { recursive: true })
    await writeFile(target, 'MOVED')
    seedExecution(source, target, 'attempting')

    const decision = await beginAttempt(deps(), moveCall(source, target))

    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') {
      expect(decision.result).toEqual({ ok: true, idempotent: true })
    }
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('succeeded')
  })

  it('崩在 attempting 且副作用没发生（source 在、target 不在）→ proceed，记录仍 attempting', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    await mkdir(p('Reading'), { recursive: true })
    await writeFile(source, 'ORIGINAL')
    seedExecution(source, target, 'attempting')

    const decision = await beginAttempt(deps(), moveCall(source, target))

    expect(decision.kind).toBe('proceed')
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('attempting')
  })

  it('崩在 attempting 且矛盾态（source、target 都在）→ reject + 翻 failed', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    await mkdir(p('Reading'), { recursive: true })
    await writeFile(source, 'ORIGINAL')
    await writeFile(target, 'OTHER')
    seedExecution(source, target, 'attempting')

    const decision = await beginAttempt(deps(), moveCall(source, target))

    expect(decision.kind).toBe('reject')
    if (decision.kind === 'reject') {
      expect(decision.result['ok']).toBe(false)
      expect(decision.result['code']).toBe('IDEMPOTENCY_CONFLICT')
    }
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('failed')
  })

  it('上次 failed → proceed 重试，翻回 attempting', async () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    seedExecution(source, target, 'failed')

    const decision = await beginAttempt(deps(), moveCall(source, target))

    expect(decision.kind).toBe('proceed')
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('attempting')
  })
})

describe('afterExecute：执行后翻转状态', () => {
  it('outcome.ok=true → 翻 succeeded，整个 outcome 存进 resultPayload', () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    seedExecution(source, target, 'attempting')
    const key = moveKey(source, target)
    const outcome = { ok: true, source: toPosix(source), target: toPosix(target) }

    afterExecute(deps(), key, outcome)

    const reloaded = repo.findByKey(key)
    expect(reloaded?.status).toBe('succeeded')
    expect(reloaded?.finishedAt).toBe(T1)
    expect(reloaded?.resultPayload).toEqual(outcome)
  })

  it('outcome.ok=false → 翻 failed，resultPayload 留 null', () => {
    const source = p('a.pdf')
    const target = p('Reading', 'a.pdf')
    seedExecution(source, target, 'attempting')
    const key = moveKey(source, target)

    afterExecute(deps(), key, { ok: false, code: 'MOVE_FAILED', reason: '目标父目录不存在' })

    const reloaded = repo.findByKey(key)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.finishedAt).toBe(T1)
    expect(reloaded?.resultPayload).toBeNull()
  })
})

describe('executor 崩溃恢复：模拟崩溃后不重复移动（TASK-021 Validation）', () => {
  const writeScope: TaskScope = {
    taskId: 't-1',
    capabilities: ['filesystem_create_dir', 'filesystem_move']
  }
  const approveGate: PermissionGate = {
    request: async () => ({ approved: true }),
    verify: async () => ({ ok: true })
  }

  function crashRun(): (params: HostExecuteToolParams) => Promise<Record<string, unknown>> {
    return createExecutor(
      writeScope,
      UI_ORIGIN,
      new RuleBasedToolRetriever(),
      { gate: approveGate },
      { executions: repo, now: () => T1 }
    )
  }

  function moveParams(source: string, target: string): HostExecuteToolParams {
    return { callId: 'tc-recover', capability: 'filesystem_move', arguments: { source, target } }
  }

  it('时刻①崩在登记前（store 无记录）→ 全新执行，正常移动，落 succeeded', async () => {
    const source = join(dir, 'a.pdf')
    const target = join(dir, 'Reading', 'a.pdf')
    await mkdir(join(dir, 'Reading'))
    await writeFile(source, 'BYTES')

    const out = await crashRun()(moveParams(source, target))

    expect(out['ok']).toBe(true)
    expect(await exists(source)).toBe(false)
    expect(await readFile(target, 'utf-8')).toBe('BYTES')
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('succeeded')
  })

  it('时刻②崩在 rename 前（记录 attempting，source 在 target 不在）→ 重跑，真的移动过去', async () => {
    const source = join(dir, 'a.pdf')
    const target = join(dir, 'Reading', 'a.pdf')
    await mkdir(join(dir, 'Reading'))
    await writeFile(source, 'BYTES')
    seedExecution(source, target, 'attempting')

    const out = await crashRun()(moveParams(source, target))

    expect(out['ok']).toBe(true)
    expect(await exists(source)).toBe(false)
    expect(await readFile(target, 'utf-8')).toBe('BYTES')
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('succeeded')
  })

  it('时刻③崩在 rename 后、翻转前（记录 attempting，source 不在 target 在）→ 跳过，不重复移动', async () => {
    const source = join(dir, 'a.pdf')
    const target = join(dir, 'Reading', 'a.pdf')
    await mkdir(join(dir, 'Reading'))
    await writeFile(target, 'ALREADY-MOVED')
    seedExecution(source, target, 'attempting')

    const out = await crashRun()(moveParams(source, target))

    // 核心断言：source 已不在，若真的重跑 moveFile 必然 MOVE_SOURCE_MISSING（ok:false）。
    // 返回 ok:true + idempotent:true 只可能是幂等 skip——证明没有重复移动。
    expect(out['ok']).toBe(true)
    expect(out['idempotent']).toBe(true)
    // 不重复移动的铁证：target 内容原封不动，source 仍不存在。
    expect(await readFile(target, 'utf-8')).toBe('ALREADY-MOVED')
    expect(await exists(source)).toBe(false)
    expect(repo.findByKey(moveKey(source, target))?.status).toBe('succeeded')
  })
})
