import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import {
  SqliteTaskRepository,
  IllegalTaskTransition,
  TASK_STATUSES,
  isTaskStatus,
  type TaskRecord
} from './task-repository'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

function makeRepo(): SqliteTaskRepository {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  return new SqliteTaskRepository(d)
}

function task(id: string, status: TaskRecord['status'] = 'pending'): TaskRecord {
  return {
    id,
    goal: `目标 ${id}`,
    status,
    createdAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z'
  }
}

describe('SqliteTaskRepository', () => {
  it('合法转换链路全通：pending → running → completed', () => {
    const repo = makeRepo()
    repo.insert(task('t-1'))
    expect(repo.findById('t-1')?.status).toBe('pending')

    repo.updateStatus('t-1', 'running', '2026-09-07T00:00:01Z')
    expect(repo.findById('t-1')?.status).toBe('running')

    repo.updateStatus('t-1', 'completed', '2026-09-07T00:00:02Z')
    const done = repo.findById('t-1')
    expect(done?.status).toBe('completed')
    // updatedAt 由调用方传入，必须原样落库
    expect(done?.updatedAt).toBe('2026-09-07T00:00:02Z')
    expect(done?.createdAt).toBe('2026-09-07T00:00:00Z')
  })

  it('非法转换被拒：跳级、倒退、终态出发', () => {
    const repo = makeRepo()
    repo.insert(task('t-1'))

    // 跳级：pending 不能直接 completed（两个值都合法，CHECK 放行，转换表必须拦）
    expect(() => repo.updateStatus('t-1', 'completed', '2026-09-07T00:00:01Z')).toThrow(
      IllegalTaskTransition
    )

    repo.updateStatus('t-1', 'running', '2026-09-07T00:00:01Z')
    repo.updateStatus('t-1', 'cancelled', '2026-09-07T00:00:02Z')

    // 终态出发
    expect(() => repo.updateStatus('t-1', 'running', '2026-09-07T00:00:03Z')).toThrow(
      IllegalTaskTransition
    )

    // 被拒的写入没有落库：状态与 updatedAt 都还是转换前那次
    const still = repo.findById('t-1')
    expect(still?.status).toBe('cancelled')
    expect(still?.updatedAt).toBe('2026-09-07T00:00:02Z')
  })

  it('CHECK 的值集合与 TASK_STATUSES 一致：漂移会让本测试红', () => {
    const repo = makeRepo()

    // 每个 TS 侧合法状态都必须能写进库
    for (const status of TASK_STATUSES) {
      expect(() => repo.insert(task(`t-${status}`, status)), `CHECK 应接受 ${status}`).not.toThrow()
    }

    // 典型非法值必须被库拒绝
    for (const bad of ['waiting_permission', 'done', 'PENDING', '']) {
      expect(
        () => repo.insert(task(`x-${bad || 'empty'}`, bad as never)),
        `CHECK 应拒绝 ${bad}`
      ).toThrow()
    }

    // Phase 2 把 waiting_permission 加进 TASK_STATUSES 时，
    // 上面第一个循环会红，逼你补一个 migration 去改 CHECK。
    expect(TASK_STATUSES).toHaveLength(5)
  })

  it('camelCase ↔ snake_case 映射正确，findById 未命中返回 null', () => {
    const repo = makeRepo()
    repo.insert(task('t-1', 'running'))

    expect(repo.findById('t-1')).toEqual({
      id: 't-1',
      goal: '目标 t-1',
      status: 'running',
      createdAt: '2026-09-07T00:00:00Z',
      updatedAt: '2026-09-07T00:00:00Z'
    })
    expect(repo.findById('不存在')).toBeNull()
    expect(repo.findAll().map((r) => r.id)).toEqual(['t-1'])
  })

  it('脏 status 被 isTaskStatus 拒：CHECK 之外的第二道保险', () => {
    const repo = makeRepo()
    repo.insert(task('t-1'))

    // 故意 DROP 重建一张不带 CHECK 的表，制造 CHECK 漂移后的最坏情况。
    // 生产路径走不到这里——上一条测试已证明 CHECK 拦得住所有写入。
    const d = db!
    d.exec('DROP TABLE tasks')
    d.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    d.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run(
      't-1',
      'g',
      'waiting_permission',
      '2026-09-07T00:00:00Z',
      '2026-09-07T00:00:00Z'
    )

    expect(isTaskStatus('waiting_permission')).toBe(false)
    expect(() => repo.findById('t-1')).toThrow(/非法值/)
  })
})
