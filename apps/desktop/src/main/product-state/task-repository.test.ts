import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import {
  SqliteTaskRepository,
  IllegalTaskTransition,
  ALLOWED_TRANSITIONS,
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

    // 典型非法值必须被库拒。'waiting' 不是 'waiting_permission' 的简写：
    // CHECK 是字符串相等，差一个字符就是非法值。
    for (const bad of ['waiting', 'done', 'PENDING', '']) {
      expect(
        () => repo.insert(task(`x-${bad || 'empty'}`, bad as never)),
        `CHECK 应拒绝 ${bad}`
      ).toThrow()
    }

    // 0005 把 waiting_permission 加进了 CHECK。这个数量钉住的是双源一致性：
    // 以后再加状态，上面第一个循环会红，逼你补一个 migration 去改 CHECK。
    expect(TASK_STATUSES).toHaveLength(6)
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
      'done',
      '2026-09-07T00:00:00Z',
      '2026-09-07T00:00:00Z'
    )

    expect(isTaskStatus('done')).toBe(false)
    expect(() => repo.findById('t-1')).toThrow(/非法值/)
  })
})

describe('waiting_permission 的转换', () => {
  it('running → waiting_permission：策略第⑤关挂起前推的状态', () => {
    const repo = makeRepo()
    repo.insert(task('t-1'))
    repo.updateStatus('t-1', 'running', '2026-09-07T00:00:01Z')

    repo.updateStatus('t-1', 'waiting_permission', '2026-09-07T00:00:02Z')

    expect(repo.findById('t-1')).toMatchObject({
      status: 'waiting_permission',
      updatedAt: '2026-09-07T00:00:02Z'
    })
  })

  it('waiting_permission → running：批准、拒绝、过期三种结算都推回 running', () => {
    const repo = makeRepo()
    repo.insert(task('t-1'))
    repo.updateStatus('t-1', 'running', '2026-09-07T00:00:01Z')
    repo.updateStatus('t-1', 'waiting_permission', '2026-09-07T00:00:02Z')

    repo.updateStatus('t-1', 'running', '2026-09-07T00:00:03Z')

    expect(repo.findById('t-1')?.status).toBe('running')
  })

  it('waiting_permission → failed：reconcile 收成进程遗留的任务', () => {
    const repo = makeRepo()
    repo.insert(task('t-1', 'waiting_permission'))

    repo.updateStatus('t-1', 'failed', '2026-09-07T00:00:01Z')

    expect(repo.findById('t-1')?.status).toBe('failed')
  })

  it('waiting_permission 不能直接到 completed：结算必须先回 running', () => {
    const repo = makeRepo()
    repo.insert(task('t-1', 'waiting_permission'))

    // broker 结算后策略先推回 running，run-task 的事务 B 再从 running 推到 completed。
    // 放行这一跳的话，任务可以在没有任何工具结果的情况下直接变成已完成。
    expect(() => repo.updateStatus('t-1', 'completed', '2026-09-07T00:00:01Z')).toThrow(
      IllegalTaskTransition
    )
  })

  it('pending 不能直接进 waiting_permission：没跑起来就不会有工具调用', () => {
    const repo = makeRepo()
    repo.insert(task('t-1'))

    expect(() => repo.updateStatus('t-1', 'waiting_permission', '2026-09-07T00:00:01Z')).toThrow(
      IllegalTaskTransition
    )
  })

  it('waiting_permission 不是终态：它必须至少有一条出边', () => {
    // 空出边的状态一旦进去就再也出不来。这条不钉具体是哪几条，
    // 只钉「不能是空的」，具体转换由上面几条分别守。
    expect(ALLOWED_TRANSITIONS.waiting_permission.length).toBeGreaterThan(0)
  })
})
