import { describe, it, expect, afterEach } from 'vitest'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../product-state/database'
import {
  SqliteTaskRepository,
  type TaskRepository,
  type TaskStatus
} from '../product-state/task-repository'
import {
  SqlitePlanRepository,
  type PlanRepository,
  type PlanRecord
} from '../product-state/plan-repository'
import { SqliteEventRepository, type EventRepository } from '../product-state/event-repository'
import { AGENT_RUN_TASK, ERROR_CODE } from '@personal-agent/protocol'
import { RuntimeError } from '../runtime/python-supervisor'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'
import { runTask, RUN_TASK_TIMEOUT_MS, type RunTaskDeps, type RuntimeSend } from './run-task'
import { PHASE1_PLAN_STEPS } from './plan-template'

const GOAL = '整理 Downloads 里的 PDF'
const T0 = '2026-09-11T00:00:00.000Z'
const AT = '2026-09-11T00:00:01.000Z'

/** host 侧最坏耗时：Budget.maxToolCalls × hostTimeoutMs */
const HOST_WORST_CASE_MS = 5 * 5000

let db: SqliteDatabase | null = null
let idCounter = 0

afterEach(() => {
  db?.close()
  db = null
})

/** 不窄化成 Sqlite*Repository：测试里要把 repository 换成抛异常的 fake，
 *  窄化了就赋不进去（fake 没有 private db 字段）。 */
type Harness = RunTaskDeps

function pythonEvents(): Array<{ type: string; payload: unknown; occurredAt: string }> {
  return [
    { type: 'task_started', payload: { goal: GOAL }, occurredAt: AT },
    {
      type: 'tool_called',
      payload: { callId: 'c-1', capability: 'filesystem.list', arguments: { rootId: 'downloads' } },
      occurredAt: AT
    },
    {
      type: 'tool_result',
      payload: { callId: 'c-1', capability: 'filesystem.list', ok: true },
      occurredAt: AT
    },
    { type: 'task_completed', payload: { factCount: 1 }, occurredAt: AT }
  ]
}

function completedResult(): unknown {
  return {
    status: 'completed',
    facts: [{ text: '下载目录里有一份 a.pdf', pageRefs: [1] }],
    events: pythonEvents()
  }
}

function failedResult(reason = '预算耗尽：已用 8 步 / 5 次工具调用'): unknown {
  return {
    status: 'failed',
    reason,
    events: [
      { type: 'task_started', payload: { goal: GOAL }, occurredAt: AT },
      { type: 'budget_exhausted', payload: { steps: 8, toolCalls: 5 }, occurredAt: AT },
      { type: 'task_failed', payload: { reason }, occurredAt: AT }
    ]
  }
}

interface RecordedCall {
  method: string
  params: unknown
  opts?: { timeoutMs?: number }
}

function sendReturning(result: unknown): RuntimeSend & { calls: RecordedCall[] } {
  const fn = ((method: string, params: unknown, opts?: { timeoutMs?: number }) => {
    fn.calls.push({ method, params, opts })
    return Promise.resolve(result)
  }) as RuntimeSend & { calls: RecordedCall[] }
  fn.calls = []
  return fn
}

function sendThrowing(err: unknown): RuntimeSend & { calls: RecordedCall[] } {
  const fn = ((method: string, params: unknown, opts?: { timeoutMs?: number }) => {
    fn.calls.push({ method, params, opts })
    return Promise.reject(err)
  }) as RuntimeSend & { calls: RecordedCall[] }
  fn.calls = []
  return fn
}

function openHarness(send: RuntimeSend = sendReturning(completedResult())): Harness {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  idCounter = 0
  return {
    db: d,
    tasks: new SqliteTaskRepository(d),
    plans: new SqlitePlanRepository(d),
    events: new SqliteEventRepository(d),
    send,
    now: () => T0,
    newId: () => `id-${++idCounter}`
  }
}

function plansFailing(inner: PlanRepository): PlanRepository {
  return {
    append: (): PlanRecord => {
      throw new Error('模拟 plan 写入失败')
    },
    findLatest: (taskId) => inner.findLatest(taskId),
    findAllVersions: (taskId) => inner.findAllVersions(taskId)
  }
}

function eventsFailingAfter(inner: EventRepository, allowed: number): EventRepository {
  let seen = 0
  return {
    append: (event) => {
      seen += 1
      if (seen > allowed) throw new Error('模拟事件写入失败')
      return inner.append(event)
    },
    listByTask: (taskId) => inner.listByTask(taskId)
  }
}

function sentTaskId(send: RuntimeSend & { calls: RecordedCall[] }): string {
  return (send.calls[0]?.params as { taskId: string }).taskId
}

describe('runTask：Golden Path', () => {
  it('返回 ok:true + completed + facts，taskId 与发给 Python 的一致', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)
    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status).toBe('completed')
    expect(out.facts).toEqual([{ text: '下载目录里有一份 a.pdf', pageRefs: [1] }])
    expect(out.taskId).toBe(sentTaskId(send))
  })

  it('Task 落库：goal 原样、状态 completed、时间戳走注入的 now', async () => {
    const h = openHarness()
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    const record = h.tasks.findById(out.taskId)
    expect(record?.goal).toBe(GOAL)
    expect(record?.status).toBe('completed')
    expect(record?.createdAt).toBe(T0)
    expect(record?.updatedAt).toBe(T0)
  })

  it('Plan v1 落库，steps 就是静态模板', async () => {
    const h = openHarness()
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    const plan = h.plans.findLatest(out.taskId)
    expect(plan?.version).toBe(1)
    expect(plan?.taskId).toBe(out.taskId)
    expect(plan?.steps).toEqual([...PHASE1_PLAN_STEPS])
    expect(plan?.createdAt).toBe(T0)
  })

  it('调 Python 之前 Task 已经是 running，不是 pending', async () => {
    const h = openHarness()
    let statusDuringSend: TaskStatus | undefined
    h.send = (_method, params) => {
      statusDuringSend = h.tasks.findById((params as { taskId: string }).taskId)?.status
      return Promise.resolve(completedResult())
    }
    await runTask(GOAL, h)

    // 事务 A 必须在 RPC 之前提交：否则这 120 秒里 UI 查到的还是 pending，
    // 而进程此刻崩了就没人知道这个任务曾经跑过。
    expect(statusDuringSend).toBe('running')
  })

  it('发的是 agent.run_task，params 只有 taskId 与 goal', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)
    await runTask(GOAL, h)

    expect(send.calls).toHaveLength(1)
    expect(send.calls[0]?.method).toBe(AGENT_RUN_TASK)
    // 3b 钉死的 RunTaskParams 就这两个字段。多塞东西 Python 侧会校验失败。
    expect(send.calls[0]?.params).toEqual({ taskId: sentTaskId(send), goal: GOAL })
  })

  it('超时用 RUN_TASK_TIMEOUT_MS，不吃 supervisor 的 30 秒默认值', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)
    await runTask(GOAL, h)

    expect(send.calls[0]?.opts?.timeoutMs).toBe(RUN_TASK_TIMEOUT_MS)
  })

  it('events 一条不增不减全落，seq 从 1 递增', async () => {
    const h = openHarness()
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    const logged = h.events.listByTask(out.taskId)
    // TS 侧不另造 task_started：engine 保证第一条就是它，再造就重复。
    expect(logged.map((e) => e.type)).toEqual([
      'task_started',
      'tool_called',
      'tool_result',
      'task_completed'
    ])
    expect(logged.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(logged[0]?.payload).toEqual({ goal: GOAL })
    expect(logged[0]?.occurredAt).toBe(AT)
  })

  it('taskId 与 planId 是两次独立的 id 生成', async () => {
    const h = openHarness()
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    expect(idCounter).toBe(2)
    const plan = h.plans.findLatest(out.taskId)
    expect(plan?.id).not.toBe(out.taskId)
  })
})

describe('runTask：任务失败', () => {
  it('Python 回 failed → Task failed，reason 透传，events 全落', async () => {
    const h = openHarness(sendReturning(failedResult('预算耗尽')))
    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    // 任务失败是正常业务结果且已落库，不是调用失败，所以 ok 仍是 true。
    expect(out.status).toBe('failed')
    expect(out.reason).toBe('预算耗尽')
    expect(out.facts).toBeUndefined()
    expect(h.tasks.findById(out.taskId)?.status).toBe('failed')
    expect(h.events.listByTask(out.taskId).map((e) => e.type)).toEqual([
      'task_started',
      'budget_exhausted',
      'task_failed'
    ])
  })

  it('send 抛 NOT_STARTED → 补一条 task_failed，payload 装 code 与 message', async () => {
    const err = new RuntimeError(RUNTIME_ERROR_CODE.NOT_STARTED, 'Python runtime 未启动')
    const send = sendThrowing(err)
    const h = openHarness(send)
    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status).toBe('failed')

    const taskId = sentTaskId(send)
    expect(h.tasks.findById(taskId)?.status).toBe('failed')
    const logged = h.events.listByTask(taskId)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.type).toBe('task_failed')
    expect(logged[0]?.payload).toEqual({
      code: RUNTIME_ERROR_CODE.NOT_STARTED,
      message: 'Python runtime 未启动'
    })
  })

  it('send 抛 TIMEOUT → 同样收成 failed，code 是 RUNTIME_TIMEOUT', async () => {
    const err = new RuntimeError(RUNTIME_ERROR_CODE.TIMEOUT, '请求 agent.run_task 超时 (120000ms)')
    const send = sendThrowing(err)
    const h = openHarness(send)
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    const taskId = sentTaskId(send)
    expect(out.status).toBe('failed')
    expect(h.tasks.findById(taskId)?.status).toBe('failed')
    const payload = h.events.listByTask(taskId)[0]?.payload as { code: string }
    expect(payload.code).toBe(RUNTIME_ERROR_CODE.TIMEOUT)
  })

  it('回传不合契约 → RESPONSE_INVALID，Task 收成 failed', async () => {
    const send = sendReturning({ status: 'completed' })
    const h = openHarness(send)
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    const taskId = sentTaskId(send)
    expect(out.status).toBe('failed')
    expect(h.tasks.findById(taskId)?.status).toBe('failed')
    const payload = h.events.listByTask(taskId)[0]?.payload as { code: string }
    expect(payload.code).toBe(RUNTIME_ERROR_CODE.RESPONSE_INVALID)
  })

  it('Python 回 error envelope 而不是 result → 也收成 failed', async () => {
    // requestRuntime 会把 error envelope 转成 reject，但形状万一漂移到这里，
    // RunTaskResult 校验必须挡住，不能把 { error: ... } 当结果落库。
    const send = sendReturning({
      error: { code: 'RUNTIME_MODEL_NOT_CONFIGURED', message: '未配置模型' }
    })
    const h = openHarness(send)
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    expect(out.status).toBe('failed')
    expect(h.tasks.findById(sentTaskId(send))?.status).toBe('failed')
  })

  it('Python 回了 completed 但 events 是空数组 → 不补事件', async () => {
    const h = openHarness(sendReturning({ status: 'completed', facts: [], events: [] }))
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    // 补一条 task_failed 会与 status:completed 自相矛盾。这是 Python 侧的 bug，
    // TS 不替它圆谎，timeline 空着就是空着。
    expect(out.status).toBe('completed')
    expect(h.events.listByTask(out.taskId)).toEqual([])
  })
})

describe('runTask：参数与故障', () => {
  it('goal 是空串 → ok:false + PROTOCOL_INVALID_REQUEST，且不建 Task', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)
    const out = await runTask('', h)

    expect(out).toEqual({
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: expect.any(String)
    })
    expect(h.tasks.findAll()).toEqual([])
    expect(send.calls).toEqual([])
  })

  it('goal 不是字符串 → ok:false，且不调 Python', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)

    for (const bad of [null, undefined, 42, {}, ['整理']]) {
      const out = await runTask(bad, h)
      expect(out.ok, `${JSON.stringify(bad)} 应该被拒`).toBe(false)
    }
    expect(h.tasks.findAll()).toEqual([])
    expect(send.calls).toEqual([])
  })

  it('事务 A 原子性：plan 写不进去时 Task 也不能留在库里', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)
    h.plans = plansFailing(h.plans)
    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe(RUNTIME_ERROR_CODE.DB_FAILED)
    // 三步没包在一个事务里的话，这里会留下一条永远停在 running 的 Task，
    // 而且 send 从没被调用过，没人会来收它。
    expect(h.tasks.findAll()).toEqual([])
    expect(send.calls).toEqual([])
  })

  it('事务 B 原子性：事件写一半失败时状态不推进，已写的事件也回滚', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)
    const realEvents = h.events
    h.events = eventsFailingAfter(realEvents, 2)
    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe(RUNTIME_ERROR_CODE.DB_FAILED)

    const taskId = sentTaskId(send)
    // 状态留在 running 是有意的：事务 B 回滚了，这条 Task 变成孤儿，
    // 下次启动由 reconcileOrphanTasks 收。比强行二次写入更可靠。
    expect(h.tasks.findById(taskId)?.status).toBe('running')
    expect(realEvents.listByTask(taskId)).toEqual([])
  })

  it('facts 不落库：product-state 只有三张表', async () => {
    const h = openHarness()
    await runTask(GOAL, h)

    const rows = h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string
    }>
    const tables = rows.map((r) => r.name)
    expect(tables).toEqual(expect.arrayContaining(['tasks', 'plans', 'execution_events']))
    // 这一片明确不持久化摘要，只在 IPC 返回值里给 UI。
    // 真要存是加 migration 0004 的事，不该在 runTask 里悄悄建表。
    expect(tables.some((t) => t.includes('summar'))).toBe(false)
  })

  it('连跑两次 taskId 不冲突，各自一套 Plan 与 events', async () => {
    const h = openHarness()
    const first = await runTask(GOAL, h)
    const second = await runTask('第二个目标', h)
    if (!first.ok || !second.ok) throw new Error('预期两次都 ok:true')

    expect(first.taskId).not.toBe(second.taskId)
    expect(h.tasks.findAll()).toHaveLength(2)
    expect(h.plans.findLatest(first.taskId)?.taskId).toBe(first.taskId)
    expect(h.plans.findLatest(second.taskId)?.taskId).toBe(second.taskId)
    expect(h.events.listByTask(first.taskId)).toHaveLength(4)
    expect(h.events.listByTask(second.taskId)).toHaveLength(4)
    // seq 是库级自增，跨任务连续，不是每个任务从 1 开始
    expect(h.events.listByTask(second.taskId)[0]?.seq).toBe(5)
  })
})

describe('RUN_TASK_TIMEOUT_MS', () => {
  it('钉住字面值，改动必须是有意的', () => {
    expect(RUN_TASK_TIMEOUT_MS).toBe(120_000)
  })

  it('必须大于 Python 侧最坏执行时间，否则 TS 先超时而 Python 还在跑', () => {
    // Budget 默认 maxToolCalls=5，每次 host 调用最坏 hostTimeoutMs=5000。
    // 这条不等式一旦破了，engine 会在 TS 已经 reject 之后继续写 stdout，
    // 那些响应找不到 pending 记录，被 supervisor 当垃圾丢掉。
    expect(RUN_TASK_TIMEOUT_MS).toBeGreaterThan(HOST_WORST_CASE_MS)
    // 还要留出真实模型的决策时间余量（Phase 3）
    expect(RUN_TASK_TIMEOUT_MS - HOST_WORST_CASE_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('必须大于 supervisor 的 defaultTimeoutMs，否则透传没有意义', () => {
    expect(RUN_TASK_TIMEOUT_MS).toBeGreaterThan(30_000)
  })
})

describe('runTask：依赖注入', () => {
  it('吃端口不吃实现：换掉三个 repository 仍能跑通', async () => {
    const h = openHarness()
    const taskCalls: string[] = []
    const realTasks = h.tasks
    const spyTasks: TaskRepository = {
      insert: (t) => {
        taskCalls.push(`insert:${t.status}`)
        realTasks.insert(t)
      },
      findById: (id) => realTasks.findById(id),
      findAll: () => realTasks.findAll(),
      updateStatus: (id, status, at) => {
        taskCalls.push(`update:${status}`)
        realTasks.updateStatus(id, status, at)
      }
    }
    h.tasks = spyTasks
    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(true)
    // 状态机路径必须是 pending → running → completed，不能跳级。
    // 直接 insert 成 running 会被 ALLOWED_TRANSITIONS 放行但绕过状态机语义。
    expect(taskCalls).toEqual(['insert:pending', 'update:running', 'update:completed'])
  })
})
