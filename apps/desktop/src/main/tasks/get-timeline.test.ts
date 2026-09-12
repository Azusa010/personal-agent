import { describe, it, expect, afterEach } from 'vitest'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import type { EventRepository, ExecutionEventRecord } from '../product-state/event-repository'
import type { PlanRepository } from '../product-state/plan-repository'
import type { TaskRecord, TaskRepository } from '../product-state/task-repository'
import { ERROR_CODE } from '@personal-agent/protocol'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'
import { getTimeline } from './get-timeline'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

function makeDeps(): {
  tasks: SqliteTaskRepository
  events: SqliteEventRepository
  plans: SqlitePlanRepository
} {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  return {
    tasks: new SqliteTaskRepository(d),
    events: new SqliteEventRepository(d),
    plans: new SqlitePlanRepository(d)
  }
}

function seed(
  tasks: SqliteTaskRepository,
  id: string,
  createdAt: string,
  status: TaskRecord['status'] = 'completed'
): void {
  tasks.insert({ id, goal: `目标 ${id}`, status: 'pending', createdAt, updatedAt: createdAt })
  if (status !== 'pending') tasks.updateStatus(id, 'running', createdAt)
  if (status === 'completed' || status === 'failed') tasks.updateStatus(id, status, createdAt)
}

describe('getTimeline', () => {
  it('指定存在的 taskId 时返回 task 与按 seq 升序的事件', () => {
    const deps = makeDeps()
    seed(deps.tasks, 't-1', '2026-09-07T00:00:00Z')
    const at = '2026-09-07T00:00:01Z'
    deps.events.append({ taskId: 't-1', type: 'task_started', payload: {}, occurredAt: at })
    deps.events.append({ taskId: 't-1', type: 'task_completed', payload: {}, occurredAt: at })

    const res = getTimeline('t-1', deps)

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.timeline?.task.id).toBe('t-1')
      expect(res.timeline?.task.status).toBe('completed')
      expect(res.timeline?.events.map((e) => e.seq)).toEqual([1, 2])
    }
  })

  it('taskId 不存在时是 ok:true + timeline:null，不是 ok:false', () => {
    const deps = makeDeps()
    seed(deps.tasks, 't-1', '2026-09-07T00:00:00Z')

    const res = getTimeline('查无此任务', deps)

    // 查一个不存在的 id 不是故障。回 ok:false 会让 UI 把正常情况渲染成错误条。
    expect(res).toEqual({ ok: true, timeline: null })
  })

  it('taskId 为 null 时读最近创建的任务', () => {
    const deps = makeDeps()
    seed(deps.tasks, 't-早', '2026-09-07T00:00:00Z')
    seed(deps.tasks, 't-晚', '2026-09-07T09:00:00Z')
    deps.events.append({
      taskId: 't-晚',
      type: 'task_started',
      payload: {},
      occurredAt: '2026-09-07T09:00:01Z'
    })

    const res = getTimeline(null, deps)

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.timeline?.task.id).toBe('t-晚')
      expect(res.timeline?.events.map((e) => e.type)).toEqual(['task_started'])
    }
  })

  it('null 取的是 created_at 末条，不是 id 字典序末条', () => {
    const deps = makeDeps()
    // findAll 的 SQL 是 ORDER BY created_at ASC, id ASC。若按 id 排，末条是 z-后建；
    // 这条用例让 created_at 与 id 的次序相反，钉住用的是 created_at。
    seed(deps.tasks, 'z-后建', '2026-09-07T00:00:00Z')
    seed(deps.tasks, 'a-先建', '2026-09-08T00:00:00Z')

    const res = getTimeline(null, deps)

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.timeline?.task.id).toBe('a-先建')
  })

  it('库是空的且 taskId 为 null 时返回 timeline:null', () => {
    const deps = makeDeps()

    expect(getTimeline(null, deps)).toEqual({ ok: true, timeline: null })
  })

  it('无事件的任务返回 timeline，events 是空数组而不是 null', () => {
    const deps = makeDeps()
    seed(deps.tasks, 't-1', '2026-09-07T00:00:00Z', 'pending')

    const res = getTimeline('t-1', deps)

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.timeline?.events).toEqual([])
  })

  it('timeline 带上最新版 plan，没 plan 的任务该字段是 null', () => {
    const deps = makeDeps()
    seed(deps.tasks, 't-1', '2026-09-07T00:00:00Z')
    seed(deps.tasks, 't-2', '2026-09-07T00:00:00Z')
    deps.plans.append({
      id: 'p-1',
      taskId: 't-1',
      steps: [{ description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' }],
      createdAt: '2026-09-07T00:00:00Z'
    })

    const withPlan = getTimeline('t-1', deps)
    const withoutPlan = getTimeline('t-2', deps)

    if (withPlan.ok) {
      expect(withPlan.timeline?.plan?.version).toBe(1)
      expect(withPlan.timeline?.plan?.steps).toHaveLength(1)
    }
    if (withoutPlan.ok) expect(withoutPlan.timeline?.plan).toBeNull()
  })

  it.each([
    ['undefined', undefined],
    ['空串', ''],
    ['数字', 42],
    ['对象', { id: 't-1' }],
    ['布尔', true]
  ])('taskId 是 %s 时返回 PROTOCOL_INVALID_REQUEST', (_label, input) => {
    const deps = makeDeps()
    seed(deps.tasks, 't-1', '2026-09-07T00:00:00Z')

    const res = getTimeline(input, deps)

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
  })

  it('undefined 不被当成 null：少传参数不该悄悄变成「读最近一个」', () => {
    const deps = makeDeps()
    seed(deps.tasks, 't-1', '2026-09-07T00:00:00Z')

    const res = getTimeline(undefined, deps)

    // 若这里返回 timeline，说明 undefined 走了 null 分支。
    expect(res.ok).toBe(false)
  })

  it('repository 抛错时返回 RUNTIME_DB_FAILED，message 原样透传', () => {
    const boom = new Error('database is locked')
    const throwingTasks: TaskRepository = {
      insert: () => {},
      findById: () => {
        throw boom
      },
      findAll: () => {
        throw boom
      },
      updateStatus: () => {}
    }
    const throwingEvents: EventRepository = {
      append: () => 1,
      listByTask: () => {
        throw boom
      }
    }

    const throwingPlans: PlanRepository = {
      append: () => {
        throw boom
      },
      findLatest: () => {
        throw boom
      },
      findAllVersions: () => {
        throw boom
      }
    }

    const broken = { tasks: throwingTasks, events: throwingEvents, plans: throwingPlans }
    const byId = getTimeline('t-1', broken)
    const byNull = getTimeline(null, broken)

    expect(byId).toEqual({ ok: false, code: RUNTIME_ERROR_CODE.DB_FAILED, message: boom.message })
    expect(byNull).toEqual({
      ok: false,
      code: RUNTIME_ERROR_CODE.DB_FAILED,
      message: boom.message
    })
  })

  it('原样返回 projectTimeline 的投影，main 侧不加任何展示字段', () => {
    const deps = makeDeps()
    seed(deps.tasks, 't-1', '2026-09-07T00:00:00Z', 'failed')
    deps.events.append({
      taskId: 't-1',
      type: 'task_failed',
      payload: { code: 'RUNTIME_MODEL_NOT_CONFIGURED', message: '运行时未配置模型' },
      occurredAt: '2026-09-07T00:00:02Z'
    })

    const res = getTimeline('t-1', deps)

    expect(res.ok).toBe(true)
    if (res.ok) {
      // payload 原样透传：展示映射是 renderer 的活，main 一旦拼中文标签，
      // 改文案就得动主进程。
      expect(res.timeline?.events[0]).toEqual({
        seq: 1,
        taskId: 't-1',
        type: 'task_failed',
        payload: { code: 'RUNTIME_MODEL_NOT_CONFIGURED', message: '运行时未配置模型' },
        occurredAt: '2026-09-07T00:00:02Z'
      } satisfies ExecutionEventRecord)
      expect(Object.keys(res.timeline!).sort()).toEqual(['events', 'plan', 'task'])
    }
  })
})
