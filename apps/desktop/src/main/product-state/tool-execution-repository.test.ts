import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { SqliteTaskRepository } from './task-repository'
import {
  SqliteToolExecutionRepository,
  IllegalToolExecutionTransition,
  ALLOWED_TRANSITIONS,
  assertTransitionAllowed,
  isToolExecutionStatus,
  TOOL_EXECUTION_STATUSES,
  type ToolExecutionRecord
} from './tool-execution-repository'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

const T0 = '2026-09-14T00:00:00.000Z'
const T1 = '2026-09-14T00:00:05.000Z'

function seedTask(d: SqliteDatabase, id = 't-1'): void {
  new SqliteTaskRepository(d).insert({
    id,
    goal: `目标 ${id}`,
    status: 'running',
    createdAt: T0,
    updatedAt: T0
  })
}

function makeRepo(): SqliteToolExecutionRepository {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  seedTask(d)
  return new SqliteToolExecutionRepository(d)
}

function execution(key: string, overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    idempotencyKey: key,
    taskId: 't-1',
    toolCallId: `call-${key}`,
    capability: 'filesystem_move',
    argsHash: `hash-${key}`,
    sourcePaths: ['D:/downloads/a.pdf'],
    targetPath: 'D:/downloads/Reading/a.pdf',
    status: 'attempting',
    attemptedAt: T0,
    finishedAt: null,
    resultPayload: null,
    ...overrides
  }
}

describe('tool_executions 表结构', () => {
  it('migration 建出 11 列，列名与 DDL 逐字对应', () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    const columns = d.prepare(`PRAGMA table_info(tool_executions)`).all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toEqual([
      'idempotency_key',
      'task_id',
      'tool_call_id',
      'capability',
      'args_hash',
      'source_paths',
      'target_path',
      'status',
      'attempted_at',
      'finished_at',
      'result_payload'
    ])
  })

  it('status 非法值被 CHECK 拦（填齐 NOT NULL 列，确保拦的是 CHECK 不是 NOT NULL）', () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    seedTask(d)
    expect(() =>
      d
        .prepare(
          `INSERT INTO tool_executions (idempotency_key, task_id, tool_call_id, capability,
            args_hash, source_paths, status, attempted_at)
           VALUES ('k','t-1','c','filesystem_move','h','[]','expired',?)`
        )
        .run(T0)
    ).toThrow(/CHECK/)
  })

  it('TOOL_EXECUTION_STATUSES 每个成员都能落库，与 SQL CHECK 同源（防双源漂移）', () => {
    const repo = makeRepo()
    TOOL_EXECUTION_STATUSES.forEach((status, i) => {
      repo.insert(execution(`k-${i}`, { status }))
      expect(repo.findByKey(`k-${i}`)?.status).toBe(status)
    })
  })
})

describe('SqliteToolExecutionRepository 读写往返', () => {
  it('insert 后 findByKey 读回，十一个字段一个不差', () => {
    const repo = makeRepo()
    const original = execution('k-1')
    repo.insert(original)
    expect(repo.findByKey('k-1')).toEqual(original)
  })

  it('targetPath 为 null 也能往返（create_dir 之外的能力可能没有 target）', () => {
    const repo = makeRepo()
    repo.insert(execution('k-1', { capability: 'filesystem_create_dir', targetPath: null }))
    expect(repo.findByKey('k-1')?.targetPath).toBeNull()
  })

  it('sourcePaths 存 JSON 数组，读回来还是数组', () => {
    const repo = makeRepo()
    repo.insert(
      execution('k-1', {
        sourcePaths: ['D:/downloads/a.pdf', 'D:/downloads/b.pdf']
      })
    )
    const found = repo.findByKey('k-1')
    expect(found?.sourcePaths).toHaveLength(2)
    expect(found?.sourcePaths[1]).toBe('D:/downloads/b.pdf')
  })

  it('resultPayload 存 JSON，读回来结构一致（命中已执行时靠它原样返回）', () => {
    const repo = makeRepo()
    const payload = { ok: true, source: 'D:/downloads/a.pdf', target: 'D:/downloads/Reading/a.pdf' }
    repo.insert(execution('k-1', { status: 'succeeded', finishedAt: T1, resultPayload: payload }))
    expect(repo.findByKey('k-1')?.resultPayload).toEqual(payload)
  })

  it('findByKey 不命中返回 null', () => {
    const repo = makeRepo()
    expect(repo.findByKey('不存在')).toBeNull()
  })

  it('findByTaskId 按 attempted_at 升序，且只返回该任务的', () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    seedTask(d, 't-1')
    seedTask(d, 't-2')
    const repo = new SqliteToolExecutionRepository(d)
    repo.insert(execution('k-late', { attemptedAt: '2026-09-14T00:03:00.000Z' }))
    repo.insert(execution('k-early', { attemptedAt: '2026-09-14T00:01:00.000Z' }))
    repo.insert(execution('k-other', { taskId: 't-2' }))
    expect(repo.findByTaskId('t-1').map((r) => r.idempotencyKey)).toEqual(['k-early', 'k-late'])
    expect(repo.findByTaskId('t-2').map((r) => r.idempotencyKey)).toEqual(['k-other'])
  })

  it('source_paths 被写成非法 JSON 时读回抛，不静默返回空数组', () => {
    const repo = makeRepo()
    repo.insert(execution('k-1'))
    db?.prepare(
      `UPDATE tool_executions SET source_paths = 'not json' WHERE idempotency_key = 'k-1'`
    ).run()
    expect(() => repo.findByKey('k-1')).toThrow(/source_paths 不是合法 JSON/)
  })

  it('result_payload 被写成非法 JSON 时读回抛', () => {
    const repo = makeRepo()
    repo.insert(
      execution('k-1', { status: 'succeeded', finishedAt: T1, resultPayload: { ok: true } })
    )
    db?.prepare(
      `UPDATE tool_executions SET result_payload = 'not json' WHERE idempotency_key = 'k-1'`
    ).run()
    expect(() => repo.findByKey('k-1')).toThrow(/result_payload 不是合法 JSON/)
  })
})

describe('SqliteToolExecutionRepository 状态翻转', () => {
  it('transition attempting→succeeded：status/finishedAt/resultPayload 都真落库', () => {
    const repo = makeRepo()
    repo.insert(execution('k-1'))
    const result = { ok: true, source: 'D:/downloads/a.pdf', target: 'D:/downloads/Reading/a.pdf' }
    const after = repo.transition('k-1', 'succeeded', T1, result)
    expect(after.status).toBe('succeeded')
    expect(after.finishedAt).toBe(T1)
    expect(after.resultPayload).toEqual(result)
    // 从库里重新读回，确认真的落库而不是只改了返回对象
    const reloaded = repo.findByKey('k-1')
    expect(reloaded?.status).toBe('succeeded')
    expect(reloaded?.resultPayload).toEqual(result)
  })

  it('transition attempting→failed：resultPayload 缺省存 null', () => {
    const repo = makeRepo()
    repo.insert(execution('k-1'))
    const after = repo.transition('k-1', 'failed', T1)
    expect(after.status).toBe('failed')
    expect(after.resultPayload).toBeNull()
    expect(repo.findByKey('k-1')?.resultPayload).toBeNull()
  })

  it('transition succeeded→attempting 抛 IllegalToolExecutionTransition，库里状态不变', () => {
    const repo = makeRepo()
    repo.insert(execution('k-1', { status: 'succeeded', finishedAt: T1 }))
    expect(() => repo.transition('k-1', 'attempting', T1)).toThrow(IllegalToolExecutionTransition)
    expect(repo.findByKey('k-1')?.status).toBe('succeeded')
  })

  it('transition 不存在的 key 抛', () => {
    const repo = makeRepo()
    expect(() => repo.transition('不存在', 'succeeded', T1)).toThrow(/不存在 key=不存在/)
  })
})

describe('状态机一致性', () => {
  it('assertTransitionAllowed 与 ALLOWED_TRANSITIONS 表逐格一致', () => {
    for (const from of TOOL_EXECUTION_STATUSES) {
      for (const to of TOOL_EXECUTION_STATUSES) {
        const allowed = ALLOWED_TRANSITIONS[from].includes(to)
        if (allowed) {
          expect(() => assertTransitionAllowed(from, to)).not.toThrow()
        } else {
          expect(() => assertTransitionAllowed(from, to)).toThrow(IllegalToolExecutionTransition)
        }
      }
    }
  })

  it('attempting→succeeded 与 attempting→failed 是执行前后翻转的核心，必须合法', () => {
    expect(ALLOWED_TRANSITIONS['attempting']).toContain('succeeded')
    expect(ALLOWED_TRANSITIONS['attempting']).toContain('failed')
  })

  it('succeeded 是终态，不能翻回 attempting（命中即跳过，不会再执行）', () => {
    expect(ALLOWED_TRANSITIONS['succeeded']).not.toContain('attempting')
  })
})

describe('isToolExecutionStatus', () => {
  it('三态都认，其它不认', () => {
    expect(isToolExecutionStatus('attempting')).toBe(true)
    expect(isToolExecutionStatus('succeeded')).toBe(true)
    expect(isToolExecutionStatus('failed')).toBe(true)
    expect(isToolExecutionStatus('expired')).toBe(false)
    expect(isToolExecutionStatus('')).toBe(false)
  })
})
