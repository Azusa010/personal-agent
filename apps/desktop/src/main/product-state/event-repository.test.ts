import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { SqliteTaskRepository, type TaskRecord } from './task-repository'
import { SqliteEventRepository } from './event-repository'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

function makeRepos(): {
  d: SqliteDatabase
  tasks: SqliteTaskRepository
  events: SqliteEventRepository
} {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  return { d, tasks: new SqliteTaskRepository(d), events: new SqliteEventRepository(d) }
}

function seedTask(tasks: SqliteTaskRepository, id: string): void {
  const record: TaskRecord = {
    id,
    goal: `目标 ${id}`,
    status: 'pending',
    createdAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z'
  }
  tasks.insert(record)
}

describe('SqliteEventRepository', () => {
  it('append 返回库分配的 seq，从 1 严格递增', () => {
    const { events, tasks } = makeRepos()
    seedTask(tasks, 't-1')

    const at = '2026-09-07T00:00:01Z'
    expect(
      events.append({ taskId: 't-1', type: 'task_started', payload: {}, occurredAt: at })
    ).toBe(1)
    expect(events.append({ taskId: 't-1', type: 'tool_called', payload: {}, occurredAt: at })).toBe(
      2
    )
    expect(
      events.append({ taskId: 't-1', type: 'task_completed', payload: {}, occurredAt: at })
    ).toBe(3)
  })

  it('listByTask 按 seq 升序，且只返回该 task 的事件', () => {
    const { events, tasks } = makeRepos()
    seedTask(tasks, 't-1')
    seedTask(tasks, 't-2')

    const at = '2026-09-07T00:00:01Z'
    events.append({ taskId: 't-1', type: 'a', payload: { n: 1 }, occurredAt: at })
    events.append({ taskId: 't-2', type: '别人的', payload: {}, occurredAt: at })
    events.append({ taskId: 't-1', type: 'b', payload: { n: 2 }, occurredAt: at })

    const mine = events.listByTask('t-1')
    expect(mine.map((e) => e.seq)).toEqual([1, 3])
    expect(mine.map((e) => e.type)).toEqual(['a', 'b'])
    expect(events.listByTask('不存在')).toEqual([])
  })

  it('payload 序列化往返：嵌套对象与数组原样回来', () => {
    const { events, tasks } = makeRepos()
    seedTask(tasks, 't-1')

    const payload = {
      tool: 'filesystem.list',
      ok: true,
      count: 3,
      entries: [
        { name: 'a.pdf', size: 10 },
        { name: 'b.pdf', size: 20 }
      ],
      nested: { deep: { deeper: null } }
    }
    events.append({
      taskId: 't-1',
      type: 'tool_called',
      payload,
      occurredAt: '2026-09-07T00:00:01Z'
    })

    const [event] = events.listByTask('t-1')
    expect(event.payload).toEqual(payload)
    expect(event.taskId).toBe('t-1')
    expect(event.occurredAt).toBe('2026-09-07T00:00:01Z')
  })

  it('第 154 行：状态更新与事件写入同事务，失败则两者都不留痕', () => {
    const { d, events, tasks } = makeRepos()
    seedTask(tasks, 't-1')

    const at = '2026-09-07T00:00:01Z'
    const commit = d.transaction(() => {
      tasks.updateStatus('t-1', 'running', at)
      events.append({ taskId: 't-1', type: 'task_started', payload: {}, occurredAt: at })
      throw new Error('模拟同事务后续步骤失败')
    })

    expect(() => commit()).toThrow('模拟同事务后续步骤失败')

    expect(tasks.findById('t-1')?.status).toBe('pending')
    expect(events.listByTask('t-1')).toEqual([])

    const ok = d.transaction(() => {
      tasks.updateStatus('t-1', 'running', at)
      events.append({ taskId: 't-1', type: 'task_started', payload: {}, occurredAt: at })
    })
    ok()

    expect(tasks.findById('t-1')?.status).toBe('running')
    expect(events.listByTask('t-1').map((e) => e.type)).toEqual(['task_started'])
  })

  it('非法 JSON payload 被拒，报错带 seq 便于定位', () => {
    const { d, events, tasks } = makeRepos()
    seedTask(tasks, 't-1')

    d.prepare(
      'INSERT INTO execution_events (task_id, type, payload, occurred_at) VALUES (?,?,?,?)'
    ).run('t-1', 'dirty', '这不是JSON', '2026-09-07T00:00:01Z')

    expect(() => events.listByTask('t-1')).toThrow(/不是合法 JSON \(seq=1/)
  })
})
