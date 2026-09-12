import { describe, it, expect, afterEach } from 'vitest'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../product-state/database'
import {
  SqliteTaskRepository,
  type TaskRecord,
  type TaskRepository,
  type TaskStatus
} from '../product-state/task-repository'
import { SqliteEventRepository } from '../product-state/event-repository'
import { reconcileOrphanTasks, type ReconcileDeps } from './reconcile'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'

const T0 = '2026-09-11T00:00:00.000Z'
const T1 = '2026-09-11T09:00:00.000Z'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

interface Harness {
  deps: ReconcileDeps
  tasks: SqliteTaskRepository
  events: SqliteEventRepository
}

function makeHarness(now: () => string = () => T1): Harness {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  const tasks = new SqliteTaskRepository(d)
  const events = new SqliteEventRepository(d)
  return { deps: { db: d, tasks, events, now }, tasks, events }
}

function seed(tasks: SqliteTaskRepository, id: string, status: TaskStatus): void {
  const record: TaskRecord = { id, goal: `目标 ${id}`, status, createdAt: T0, updatedAt: T0 }
  tasks.insert(record)
}

/** 只对 badId 抛，其余照常。用来验「一个坏任务不连累其他」。 */
function tasksFailingOn(inner: TaskRepository, badId: string): TaskRepository {
  return {
    insert: (t) => inner.insert(t),
    findById: (id) => inner.findById(id),
    findAll: () => inner.findAll(),
    updateStatus: (id, status, at) => {
      if (id === badId) throw new Error(`模拟 ${badId} 写坏`)
      inner.updateStatus(id, status, at)
    }
  }
}

function tasksAlwaysFailing(inner: TaskRepository): TaskRepository {
  return {
    insert: (t) => inner.insert(t),
    findById: (id) => inner.findById(id),
    findAll: () => inner.findAll(),
    updateStatus: () => {
      throw new Error('模拟状态写入失败')
    }
  }
}

describe('reconcileOrphanTasks', () => {
  it('空库返回 0，不抛', () => {
    const { deps } = makeHarness()
    expect(reconcileOrphanTasks(deps)).toBe(0)
  })

  it('没有孤儿时返回 0，已有任务原样不动', () => {
    const { deps, tasks, events } = makeHarness()
    seed(tasks, 't-1', 'completed')
    seed(tasks, 't-2', 'pending')

    expect(reconcileOrphanTasks(deps)).toBe(0)
    expect(tasks.findById('t-1')?.status).toBe('completed')
    expect(tasks.findById('t-2')?.status).toBe('pending')
    expect(events.listByTask('t-1')).toEqual([])
  })

  it('一个 running 被收成 failed，并补一条 task_failed 事件', () => {
    const { deps, tasks, events } = makeHarness()
    seed(tasks, 't-1', 'running')

    expect(reconcileOrphanTasks(deps)).toBe(1)
    expect(tasks.findById('t-1')?.status).toBe('failed')

    const logged = events.listByTask('t-1')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.type).toBe('task_failed')
  })

  it('补的事件 payload 用 ORPHANED 码，形状与 runTask 补的一致', () => {
    const { deps, tasks, events } = makeHarness()
    seed(tasks, 't-1', 'running')
    reconcileOrphanTasks(deps)

    // UI 渲染 task_failed 只有一个分支，payload 必须是 { code, message }。
    // 复用 CRASHED 的话分不清「刚刚崩了」和「上次崩了留下的」。
    const payload = events.listByTask('t-1')[0]?.payload as { code: string; message: string }
    expect(payload.code).toBe(RUNTIME_ERROR_CODE.ORPHANED)
    expect(typeof payload.message).toBe('string')
    expect(payload.message.length).toBeGreaterThan(0)
  })

  it('只收 running：其余四种状态一律不碰', () => {
    const { deps, tasks, events } = makeHarness()
    const others: TaskStatus[] = ['pending', 'completed', 'failed', 'cancelled']
    others.forEach((status, i) => seed(tasks, `t-${i}`, status))
    seed(tasks, 't-orphan', 'running')

    expect(reconcileOrphanTasks(deps)).toBe(1)
    others.forEach((status, i) => {
      expect(tasks.findById(`t-${i}`)?.status, `${status} 被误动了`).toBe(status)
      expect(events.listByTask(`t-${i}`)).toEqual([])
    })
  })

  it('多个孤儿全部收掉，返回数量', () => {
    const { deps, tasks } = makeHarness()
    seed(tasks, 't-1', 'running')
    seed(tasks, 't-2', 'running')
    seed(tasks, 't-3', 'running')
    seed(tasks, 't-ok', 'completed')

    expect(reconcileOrphanTasks(deps)).toBe(3)
    for (const id of ['t-1', 't-2', 't-3']) {
      expect(tasks.findById(id)?.status).toBe('failed')
    }
  })

  it('单个任务收尸失败不连累其余，也不让整个调用抛', () => {
    const { deps, tasks, events } = makeHarness()
    seed(tasks, 't-bad', 'running')
    seed(tasks, 't-good', 'running')

    const wrapped: ReconcileDeps = { ...deps, tasks: tasksFailingOn(tasks, 't-bad') }
    // 收尸失败不是致命错误，启动流程不该被中断，所以这里不能抛。
    expect(reconcileOrphanTasks(wrapped)).toBe(1)
    expect(tasks.findById('t-good')?.status).toBe('failed')
    expect(events.listByTask('t-good')).toHaveLength(1)
    expect(tasks.findById('t-bad')?.status).toBe('running')
  })

  it('事件与状态在同一个事务：状态写不进去时事件也不能留下', () => {
    const { deps, tasks, events } = makeHarness()
    seed(tasks, 't-1', 'running')

    const wrapped: ReconcileDeps = { ...deps, tasks: tasksAlwaysFailing(tasks) }
    expect(() => reconcileOrphanTasks(wrapped)).not.toThrow()

    // 没包事务的话这条 append 会留在库里，timeline 上出现一条
    // 「任务失败了」但 Task 状态还是 running 的矛盾记录。
    expect(events.listByTask('t-1')).toEqual([])
    expect(tasks.findById('t-1')?.status).toBe('running')
  })

  it('时间戳走注入的 now：updatedAt 与事件 occurredAt 同源', () => {
    const { deps, tasks, events } = makeHarness(() => T1)
    seed(tasks, 't-1', 'running')
    reconcileOrphanTasks(deps)

    expect(tasks.findById('t-1')?.updatedAt).toBe(T1)
    expect(events.listByTask('t-1')[0]?.occurredAt).toBe(T1)
    // createdAt 是任务建立时刻，收尸不该动它
    expect(tasks.findById('t-1')?.createdAt).toBe(T0)
  })
})
