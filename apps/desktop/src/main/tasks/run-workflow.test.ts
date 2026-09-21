import { describe, it, expect, afterEach } from 'vitest'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteEventRepository } from '../product-state/event-repository'
import { currentTask, endTask } from '../policy/task-context'
import { RuntimeError } from '../runtime/python-supervisor'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'
import { ERROR_CODE } from '@personal-agent/protocol'
import { runWorkflow, type RunWorkflowDeps, type RuntimeSend } from './run-workflow'

const AT = '2026-09-20T10:00:01.000Z'

let db: SqliteDatabase | null = null
let idCounter = 0

afterEach(() => {
  endTask()
  db?.close()
  db = null
})

function makeHarness(send: RuntimeSend): RunWorkflowDeps {
  db = openProductState(MEMORY_DB)
  migrate(db)
  idCounter = 0
  return {
    db,
    tasks: new SqliteTaskRepository(db),
    plans: new SqlitePlanRepository(db),
    events: new SqliteEventRepository(db),
    send,
    now: () => AT,
    newId: () => `id-${++idCounter}`
  }
}

describe('runWorkflow：确定性工作流执行', () => {
  it('成功路径：写入 5 步静态 Plan，Task 终态 completed，事件全数入库', async () => {
    const fakeEvents = [
      { type: 'task_started', payload: { workflowId: 'golden_path' }, occurredAt: AT },
      { type: 'tool_called', payload: { capability: 'filesystem_list' }, occurredAt: AT },
      { type: 'tool_result', payload: { ok: true }, occurredAt: AT },
      {
        type: 'task_completed',
        payload: { reply: '已归档完成', factCount: 1 },
        occurredAt: AT
      }
    ]

    let receivedMethod = ''
    let receivedParams: unknown = null

    const send: RuntimeSend = async (method, params) => {
      receivedMethod = method
      receivedParams = params
      return {
        status: 'completed',
        reply: '已把 test.pdf 移到 Reading',
        facts: [{ text: '第一页摘要', pageRefs: [1] }],
        events: fakeEvents
      }
    }

    const deps = makeHarness(send)
    const result = await runWorkflow({ workflowId: 'golden_path' }, deps)

    expect(receivedMethod).toBe('agent.run_workflow')
    expect(receivedParams).toEqual({
      taskId: 'id-1',
      workflowId: 'golden_path',
      inputs: {}
    })

    expect(result).toEqual({
      ok: true,
      taskId: 'id-1',
      status: 'completed',
      reply: '已把 test.pdf 移到 Reading',
      facts: [{ text: '第一页摘要', pageRefs: [1] }]
    })

    // 检查 Task 状态
    const task = deps.tasks.findById('id-1')
    expect(task).not.toBeNull()
    expect(task?.status).toBe('completed')
    expect(task?.goal).toBe('workflow:golden_path')

    // 检查静态 Plan 写入
    const plan = deps.plans.findLatest('id-1')
    expect(plan).not.toBeNull()
    expect(plan?.steps).toHaveLength(5)
    expect(plan?.steps[0].capability).toBe('filesystem_list')
    expect(plan?.steps[4].capability).toBe('scheduler_create')

    // 检查事件持久化
    const savedEvents = deps.events.listByTask('id-1')
    expect(savedEvents).toHaveLength(4)
    expect(savedEvents[0].type).toBe('task_started')
    expect(savedEvents[3].type).toBe('task_completed')

    // 槽位必须被释放
    expect(currentTask()).toBeNull()
  })

  it('未知工作流 ID 立即拒绝，不占槽也不建库记录', async () => {
    const send: RuntimeSend = async () => ({})
    const deps = makeHarness(send)

    const result = await runWorkflow({ workflowId: 'non_existent' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }

    expect(deps.tasks.findAll()).toHaveLength(0)
    expect(currentTask()).toBeNull()
  })

  it('任务占槽：已有任务正在跑时返回 TASK_BUSY', async () => {
    const send: RuntimeSend = async () => ({})
    const deps = makeHarness(send)

    // 先模拟一个任务占住槽位
    const { beginTask } = await import('../policy/task-context')
    beginTask('busy-task', '正在忙', [])

    const result = await runWorkflow({ workflowId: 'golden_path' }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(RUNTIME_ERROR_CODE.TASK_BUSY)
      expect(result.message).toContain('busy-task')
    }

    // 数据库不留脏记录
    expect(deps.tasks.findAll()).toHaveLength(0)
  })

  it('运行时失败收场：Python 返回 failed 终态如实落库', async () => {
    const send: RuntimeSend = async () => ({
      status: 'failed',
      reason: 'PERMISSION_DENIED: 用户拒绝权限',
      events: [
        { type: 'task_started', payload: {}, occurredAt: AT },
        { type: 'task_failed', payload: { reason: 'PERMISSION_DENIED' }, occurredAt: AT }
      ]
    })

    const deps = makeHarness(send)
    const result = await runWorkflow({ workflowId: 'golden_path' }, deps)

    expect(result).toEqual({
      ok: true,
      taskId: 'id-1',
      status: 'failed',
      reason: 'PERMISSION_DENIED: 用户拒绝权限'
    })

    const task = deps.tasks.findById('id-1')
    expect(task?.status).toBe('failed')

    expect(currentTask()).toBeNull()
  })

  it('网络崩溃/异常：RuntimeError 触发 task_failed 事件并落库 failed', async () => {
    const send: RuntimeSend = async () => {
      throw new RuntimeError('CRASHED', '子进程已退出')
    }

    const deps = makeHarness(send)
    const result = await runWorkflow({ workflowId: 'golden_path' }, deps)

    expect(result).toEqual({
      ok: true,
      taskId: 'id-1',
      status: 'failed',
      reason: '子进程已退出'
    })

    const task = deps.tasks.findById('id-1')
    expect(task?.status).toBe('failed')

    const events = deps.events.listByTask('id-1')
    const failedEvent = events.find((e) => e.type === 'task_failed')
    expect(failedEvent).toBeDefined()
    expect(failedEvent?.payload).toEqual({
      code: 'CRASHED',
      message: '子进程已退出'
    })

    expect(currentTask()).toBeNull()
  })
})
