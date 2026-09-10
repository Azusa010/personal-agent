import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { SqliteTaskRepository, type TaskRecord, type TaskRepository } from './task-repository'
import {
  SqliteEventRepository,
  type EventRepository,
  type ExecutionEventRecord
} from './event-repository'
import { projectTimeline } from './timeline-projection'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

function makeRepos(): { tasks: SqliteTaskRepository; events: SqliteEventRepository } {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  return { tasks: new SqliteTaskRepository(d), events: new SqliteEventRepository(d) }
}

function seed(
  tasks: SqliteTaskRepository,
  id: string,
  status: TaskRecord['status'] = 'pending'
): void {
  tasks.insert({
    id,
    goal: `目标 ${id}`,
    status,
    createdAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z'
  })
}

describe('projectTimeline', () => {
  it('组合 task 与其事件，事件按 seq 升序', () => {
    const { tasks, events } = makeRepos()
    seed(tasks, 't-1')
    tasks.updateStatus('t-1', 'running', '2026-09-07T00:00:01Z')

    const at = '2026-09-07T00:00:01Z'
    events.append({ taskId: 't-1', type: 'task_started', payload: {}, occurredAt: at })
    events.append({
      taskId: 't-1',
      type: 'tool_called',
      payload: { tool: 'filesystem.list', count: 3 },
      occurredAt: at
    })

    const timeline = projectTimeline(tasks, events, 't-1')

    expect(timeline?.task.id).toBe('t-1')
    expect(timeline?.task.status).toBe('running')
    expect(timeline?.events.map((e) => e.seq)).toEqual([1, 2])
    expect(timeline?.events.map((e) => e.type)).toEqual(['task_started', 'tool_called'])
    // payload 经 JSON 往返后结构原样
    expect(timeline?.events[1].payload).toEqual({ tool: 'filesystem.list', count: 3 })
  })

  it('多 task 隔离：t-1 的投影不含 t-2 的事件', () => {
    const { tasks, events } = makeRepos()
    seed(tasks, 't-1')
    seed(tasks, 't-2')

    const at = '2026-09-07T00:00:01Z'
    events.append({ taskId: 't-1', type: 'a', payload: {}, occurredAt: at })
    events.append({ taskId: 't-2', type: '别人的', payload: {}, occurredAt: at })
    events.append({ taskId: 't-1', type: 'b', payload: {}, occurredAt: at })

    const timeline = projectTimeline(tasks, events, 't-1')

    expect(timeline?.events.map((e) => e.seq)).toEqual([1, 3])
    expect(timeline?.events.map((e) => e.type)).toEqual(['a', 'b'])
  })

  it('task 不存在返回 null；无事件的 task 返回空数组而非 null', () => {
    const { tasks, events } = makeRepos()
    seed(tasks, 't-1')

    expect(projectTimeline(tasks, events, '不存在')).toBeNull()

    const empty = projectTimeline(tasks, events, 't-1')
    expect(empty).not.toBeNull()
    expect(empty?.events).toEqual([]) // 空数组，调用方不用判 null
    expect(empty?.task.status).toBe('pending')
  })

  it('投影反映最新状态：状态推进后再次投影即更新', () => {
    const { tasks, events } = makeRepos()
    seed(tasks, 't-1')

    expect(projectTimeline(tasks, events, 't-1')?.task.status).toBe('pending')

    const d = db!
    const commit = d.transaction(() => {
      tasks.updateStatus('t-1', 'running', '2026-09-07T00:00:05Z')
      events.append({
        taskId: 't-1',
        type: 'task_running',
        payload: { summary: 'running' },
        occurredAt: '2026-09-07T00:00:05Z'
      })
    })
    commit()

    const after = projectTimeline(tasks, events, 't-1')
    expect(after?.task.status).toBe('running')
    expect(after?.task.updatedAt).toBe('2026-09-07T00:00:05Z')
    expect(after?.events.map((e) => e.type)).toEqual(['task_running'])
  })

  it('只依赖端口：注入内存 fake 也能投影，证明与 SQLite 解耦', () => {
    const fakeTask: TaskRecord = {
      id: 'fake-1',
      goal: '内存 fake',
      status: 'running',
      createdAt: '2026-09-07T00:00:00Z',
      updatedAt: '2026-09-07T00:00:01Z'
    }
    const fakeEvents: ExecutionEventRecord[] = [
      {
        seq: 7,
        taskId: 'fake-1',
        type: 'task_started',
        payload: { n: 1 },
        occurredAt: '2026-09-07T00:00:01Z'
      }
    ]

    const fakeTasks: TaskRepository = {
      insert: () => {},
      findById: (id) => (id === 'fake-1' ? fakeTask : null),
      findAll: () => [fakeTask],
      updateStatus: () => {}
    }
    const fakeEventRepo: EventRepository = {
      // 参数省略而不是写 _e 占位：TS 允许少参数的函数赋给多参数的签名，
      // 而这个 fake 只关心返回值，不关心入参。
      append: () => 7,
      listByTask: (id) => (id === 'fake-1' ? fakeEvents : [])
    }

    const timeline = projectTimeline(fakeTasks, fakeEventRepo, 'fake-1')
    expect(timeline?.task.goal).toBe('内存 fake')
    expect(timeline?.events.map((e) => e.seq)).toEqual([7]) // seq 原样透传，不被重新编号
    expect(projectTimeline(fakeTasks, fakeEventRepo, '别的')).toBeNull()
  })
})
