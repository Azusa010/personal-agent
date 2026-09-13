import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { SqliteTaskRepository } from './task-repository'
import {
  SqlitePermissionRepository,
  PermissionAlreadyDecided,
  isPermissionStatus,
  type PermissionRecord
} from './permission-repository'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

function makeRepo(): SqlitePermissionRepository {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  new SqliteTaskRepository(d).insert({
    id: 't-1',
    goal: '整理下载目录',
    status: 'running',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z'
  })
  return new SqlitePermissionRepository(d)
}

function permission(id: string, overrides: Partial<PermissionRecord> = {}): PermissionRecord {
  return {
    id,
    taskId: 't-1',
    toolCallId: `call-${id}`,
    capability: 'filesystem.move',
    argsCanonical: '{"source":"D:/downloads/a.pdf","target":"D:/downloads/Reading/a.pdf"}',
    argsHash: `hash-${id}`,
    status: 'pending',
    requestedAt: '2026-09-13T00:00:00.000Z',
    expiresAt: '2026-09-13T00:05:00.000Z',
    decidedAt: null,
    sourcePaths: ['D:/downloads/a.pdf'],
    targetPath: 'D:/downloads/Reading/a.pdf',
    ...overrides
  }
}

describe('permissions 表结构', () => {
  it('migration 建出 12 列，status 的 CHECK 不含 expired', () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    const columns = d.prepare(`PRAGMA table_info(permissions)`).all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'task_id',
      'tool_call_id',
      'capability',
      'args_canonical',
      'args_hash',
      'status',
      'requested_at',
      'expires_at',
      'decided_at',
      'source_paths',
      'target_path'
    ])
    // expired 是查询时投影出来的，落库要能被 CHECK 拦住
    expect(() =>
      d.prepare(`INSERT INTO permissions (id, status) VALUES ('x', 'expired')`).run()
    ).toThrow()
  })
})

describe('SqlitePermissionRepository', () => {
  it('插入后按 id 读回，十二个字段一个不差', () => {
    const repo = makeRepo()
    const original = permission('p-1')
    repo.insert(original)
    expect(repo.findById('p-1')).toEqual(original)
  })

  it('targetPath 为 null 也能往返', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1', { capability: 'filesystem.create_dir', targetPath: null }))
    expect(repo.findById('p-1')?.targetPath).toBeNull()
  })

  it('sourcePaths 存的是 JSON 数组，读回来还是数组', () => {
    const repo = makeRepo()
    repo.insert(
      permission('p-1', {
        sourcePaths: ['D:/downloads/a.pdf', 'D:/downloads/b.pdf', 'D:/downloads/c.pdf']
      })
    )
    const found = repo.findById('p-1')
    expect(found?.sourcePaths).toHaveLength(3)
    expect(found?.sourcePaths[1]).toBe('D:/downloads/b.pdf')
  })

  it('findById 不命中返回 null', () => {
    const repo = makeRepo()
    expect(repo.findById('不存在')).toBeNull()
  })

  it('findByToolCallId 命中与不命中', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1', { toolCallId: 'call-abc' }))
    expect(repo.findByToolCallId('call-abc')?.id).toBe('p-1')
    expect(repo.findByToolCallId('call-没这个')).toBeNull()
  })

  it('同一个 toolCallId 插第二条被 UNIQUE 拒', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1', { toolCallId: 'call-abc' }))
    expect(() => repo.insert(permission('p-2', { toolCallId: 'call-abc' }))).toThrow(/UNIQUE/)
    expect(repo.findByToolCallId('call-abc')?.id).toBe('p-1')
  })

  it('findByTaskId 按 requestedAt 升序，且只返回该任务的', () => {
    const d = openProductState(MEMORY_DB)
    db = d
    migrate(d)
    const tasks = new SqliteTaskRepository(d)
    for (const id of ['t-1', 't-2']) {
      tasks.insert({
        id,
        goal: `目标 ${id}`,
        status: 'running',
        createdAt: '2026-09-13T00:00:00.000Z',
        updatedAt: '2026-09-13T00:00:00.000Z'
      })
    }
    const repo = new SqlitePermissionRepository(d)
    repo.insert(permission('p-late', { requestedAt: '2026-09-13T00:03:00.000Z' }))
    repo.insert(permission('p-early', { requestedAt: '2026-09-13T00:01:00.000Z' }))
    repo.insert(permission('p-other', { taskId: 't-2' }))

    expect(repo.findByTaskId('t-1').map((p) => p.id)).toEqual(['p-early', 'p-late'])
    expect(repo.findByTaskId('t-2').map((p) => p.id)).toEqual(['p-other'])
  })

  it('decide 写 approved：status 与 decidedAt 都落库', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1'))
    const decided = repo.decide('p-1', 'approved', '2026-09-13T00:00:30.000Z')
    expect(decided.status).toBe('approved')
    expect(decided.decidedAt).toBe('2026-09-13T00:00:30.000Z')
    expect(repo.findById('p-1')).toEqual(decided)
  })

  it('decide 写 denied 同理', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1'))
    repo.decide('p-1', 'denied', '2026-09-13T00:00:30.000Z')
    expect(repo.findById('p-1')?.status).toBe('denied')
  })

  it('同一决定重复调用幂等，decidedAt 不被第二次的时间覆盖', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1'))
    repo.decide('p-1', 'approved', '2026-09-13T00:00:30.000Z')
    const again = repo.decide('p-1', 'approved', '2026-09-13T00:04:00.000Z')
    expect(again.decidedAt).toBe('2026-09-13T00:00:30.000Z')
    expect(repo.findById('p-1')?.decidedAt).toBe('2026-09-13T00:00:30.000Z')
  })

  it('先 approve 再 deny 抛 PermissionAlreadyDecided，库里的结论不变', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1'))
    repo.decide('p-1', 'approved', '2026-09-13T00:00:30.000Z')
    expect(() => repo.decide('p-1', 'denied', '2026-09-13T00:01:00.000Z')).toThrow(
      PermissionAlreadyDecided
    )
    expect(repo.findById('p-1')?.status).toBe('approved')
  })

  it('PermissionAlreadyDecided 带着两边的结论，便于上层拼错误信息', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1'))
    repo.decide('p-1', 'denied', '2026-09-13T00:00:30.000Z')
    try {
      repo.decide('p-1', 'approved', '2026-09-13T00:01:00.000Z')
      expect.unreachable('应该抛')
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionAlreadyDecided)
      const err = e as PermissionAlreadyDecided
      expect(err.permissionId).toBe('p-1')
      expect(err.existing).toBe('denied')
      expect(err.attempted).toBe('approved')
    }
  })

  it('decide 不存在的 id 抛', () => {
    const repo = makeRepo()
    expect(() => repo.decide('不存在', 'approved', '2026-09-13T00:00:30.000Z')).toThrow(
      /不存在 id=不存在/
    )
  })

  it('source_paths 被写成非法 JSON 时读回来抛，不静默返回空数组', () => {
    const repo = makeRepo()
    repo.insert(permission('p-1'))
    db?.prepare(`UPDATE permissions SET source_paths = 'not json' WHERE id = 'p-1'`).run()
    expect(() => repo.findById('p-1')).toThrow(/source_paths 不是合法 JSON/)
  })
})

describe('isPermissionStatus', () => {
  it('落库的三种状态都认，expired 不认', () => {
    expect(isPermissionStatus('pending')).toBe(true)
    expect(isPermissionStatus('approved')).toBe(true)
    expect(isPermissionStatus('denied')).toBe(true)
    expect(isPermissionStatus('expired')).toBe(false)
    expect(isPermissionStatus('')).toBe(false)
  })
})
