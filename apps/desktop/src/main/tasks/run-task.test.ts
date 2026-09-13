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
import { AGENT_MAKE_PLAN, AGENT_RUN_TASK, ERROR_CODE } from '@personal-agent/protocol'
import { RuntimeError } from '../runtime/python-supervisor'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'
import { currentTask, endTask, type ActiveTask } from '../policy/task-context'
import {
  runTask,
  RUN_TASK_TIMEOUT_MS,
  MAKE_PLAN_TIMEOUT_MS,
  type RunTaskDeps,
  type RuntimeSend
} from './run-task'

const GOAL = '整理 Downloads 里的 PDF'
const T0 = '2026-09-11T00:00:00.000Z'
const AT = '2026-09-11T00:00:01.000Z'

/** host 侧最坏耗时：Budget.maxToolCalls × hostTimeoutMs */
const HOST_WORST_CASE_MS = 5 * 5000

let db: SqliteDatabase | null = null
let idCounter = 0

afterEach(() => {
  // 安全网：某条测试把槽位漏下了，后面的测试会全数吃 TASK_BUSY，
  // 而失败信息会指向毫不相干的断言。
  endTask()
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

/** Python 侧 planning.make_plan 的真回包。第三步没有 capability 键（exclude_none 剔掉了，
 *  不是 null）——zod 的 optional 不收 null，写成 null 这条 stub 就跟真链路不一样了。 */
const PLAN_STEPS = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '基于页面内容生成带页码引用的摘要' }
]

function planResult(steps: unknown = PLAN_STEPS): unknown {
  return { steps }
}

type Responder = (method: string) => unknown

function makeStub(respond: Responder): RuntimeSend & { calls: RecordedCall[] } {
  const fn = ((method: string, params: unknown, opts?: { timeoutMs?: number }) => {
    fn.calls.push({ method, params, opts })
    const value = respond(method)
    // 值是 Error 就 reject：模拟 supervisor 把 error envelope 或超时转成的 RuntimeError。
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
  }) as RuntimeSend & { calls: RecordedCall[] }
  fn.calls = []
  return fn
}

/** 按 method 分流：make_plan 回计划，其余（就只run_task）回执行结果。 */
function sendReturning(
  result: unknown,
  plan: unknown = planResult()
): RuntimeSend & { calls: RecordedCall[] } {
  return makeStub((m) => (m === AGENT_MAKE_PLAN ? plan : result))
}

/** 默认只在 run_task 上抛：make_plan 排在前面，那边抛的话根本走不到 run_task。 */
function sendThrowing(
  err: unknown,
  method: string = AGENT_RUN_TASK
): RuntimeSend & { calls: RecordedCall[] } {
  return makeStub((m) => {
    if (m === method) return err
    return m === AGENT_MAKE_PLAN ? planResult() : completedResult()
  })
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
  // 现在一个任务发两次 RPC，两次的 taskId 必须相同（计划要绑到同一个任务上），
  // 所以取哪个都行；显式找 run_task 是为了让意图看得懂。
  const call = send.calls.find((c) => c.method === AGENT_RUN_TASK) ?? send.calls[0]
  return (call?.params as { taskId: string }).taskId
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

  it('Plan v1 落库，steps 就是 make_plan 的回包', async () => {
    const h = openHarness()
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    const plan = h.plans.findLatest(out.taskId)
    expect(plan?.version).toBe(1)
    expect(plan?.taskId).toBe(out.taskId)
    expect(plan?.steps).toEqual(PLAN_STEPS)
    expect(plan?.createdAt).toBe(T0)
  })

  it('调 agent.run_task 之前 Task 已经是 running，索要计划时还没建', async () => {
    const h = openHarness()
    let statusDuringRun: TaskStatus | undefined
    let statusDuringPlan: TaskStatus | null = 'running'
    h.send = (method, params) => {
      const found = h.tasks.findById((params as { taskId: string }).taskId)?.status
      if (method === AGENT_MAKE_PLAN) statusDuringPlan = found ?? null
      else statusDuringRun = found
      return Promise.resolve(method === AGENT_MAKE_PLAN ? planResult() : completedResult())
    }
    await runTask(GOAL, h)

    // 事务 A 必须在 run_task 之前提交：否则这 120 秒里 UI 查到的还是 pending，
    // 而进程此刻崩了就没人知道这个任务曾经跑过。
    expect(statusDuringRun).toBe('running')
    // 反过来，索要计划时库里应该什么都没有：计划拿不到就不建 Task，
    // 否则会留一条永远停在 pending 的孤儿（reconcileOrphanTasks 只收 running 的）。
    expect(statusDuringPlan).toBeNull()
  })

  it('两次 RPC：先 make_plan 后 run_task，params 都只有 taskId 与 goal', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)
    await runTask(GOAL, h)

    const taskId = sentTaskId(send)
    expect(send.calls.map((c) => c.method)).toEqual([AGENT_MAKE_PLAN, AGENT_RUN_TASK])
    // 两个 Params 的字段逐字相同（envelope.test.ts 钉着），多塞东西 Python 侧会校验失败。
    expect(send.calls[0]?.params).toEqual({ taskId, goal: GOAL })
    expect(send.calls[1]?.params).toEqual({ taskId, goal: GOAL })
  })

  it('两次 RPC 各用自己的超时，不吃 supervisor 的 30 秒默认值', async () => {
    const send = sendReturning(completedResult())
    const h = openHarness(send)
    await runTask(GOAL, h)

    expect(send.calls[0]?.opts?.timeoutMs).toBe(MAKE_PLAN_TIMEOUT_MS)
    expect(send.calls[1]?.opts?.timeoutMs).toBe(RUN_TASK_TIMEOUT_MS)
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
    // 而且 run_task 从没被调用过，没人会来收它。
    expect(h.tasks.findAll()).toEqual([])
    expect(send.calls.map((c) => c.method)).toEqual([AGENT_MAKE_PLAN])
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

describe('runTask：索要计划', () => {
  it('计划原样落库：Python 回四步就落四步，TS 不裁剪不重排', async () => {
    const four = [...PLAN_STEPS, { description: '多出来的一步', capability: 'filesystem.list' }]
    const h = openHarness(sendReturning(completedResult(), planResult(four)))
    const out = await runTask(GOAL, h)
    if (!out.ok) throw new Error('预期 ok:true')

    // ActionAlignment 拿计划里第 i 个带 capability 的步骤比对第 i 次 tool call，
    // TS 在这儿动一下手脚，比对基准就与实际执行对不上了。
    expect(h.plans.findLatest(out.taskId)?.steps).toEqual(four)
  })

  it('Python 回 PLAN_NOT_BUILDABLE → 码原样透传，不建 Task，不发 run_task', async () => {
    const send = sendThrowing(
      new RuntimeError(
        RUNTIME_ERROR_CODE.PLAN_NOT_BUILDABLE,
        '计划需要 filesystem.list，但它不在模型可见的能力清单里'
      ),
      AGENT_MAKE_PLAN
    )
    const h = openHarness(send)
    const out = await runTask(GOAL, h)

    expect(out).toEqual({
      ok: false,
      code: RUNTIME_ERROR_CODE.PLAN_NOT_BUILDABLE,
      message: expect.stringContaining('filesystem.list')
    })
    expect(h.tasks.findAll()).toEqual([])
    expect(send.calls.map((c) => c.method)).toEqual([AGENT_MAKE_PLAN])
  })

  it('make_plan 超时 → RUNTIME_TIMEOUT，任务根本没开始', async () => {
    const send = sendThrowing(
      new RuntimeError(RUNTIME_ERROR_CODE.TIMEOUT, '请求 agent.make_plan 超时 (10000ms)'),
      AGENT_MAKE_PLAN
    )
    const h = openHarness(send)
    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe(RUNTIME_ERROR_CODE.TIMEOUT)
    expect(h.tasks.findAll()).toEqual([])
  })

  it('计划回包不合契约 → PLAN_INVALID，且不建 Task', async () => {
    // steps 为空：Main 侧的 ActionAlignment 会没有比对基准。
    // capability 是 null：zod 的 optional 收 undefined 不收 null，Python 侧靠
    // exclude_none 剔键才两边对得上。
    // capability 是枚举外的能力名：契约层就该拦，不能等执行时才发现。
    const bad = [
      {},
      { steps: [] },
      { steps: [{ description: '' }] },
      { steps: [{ description: '一', capability: null }] },
      { steps: [{ description: '一', capability: 'filesystem.delete' }] }
    ]
    // 共用一个 harness：五次尝试里哪一次偷偷建了 Task，后面的 findAll 就会看见。
    const h = openHarness()
    for (const plan of bad) {
      h.send = sendReturning(completedResult(), plan)
      const out = await runTask(GOAL, h)

      expect(out.ok, `${JSON.stringify(plan)} 应该被拒`).toBe(false)
      if (out.ok) continue
      expect(out.code).toBe(RUNTIME_ERROR_CODE.PLAN_INVALID)
    }
    expect(h.tasks.findAll()).toEqual([])
  })

  it('未登记的 Python 码收成 CRASHED，不把陌生字符串推给 UI', async () => {
    const send = sendThrowing(new RuntimeError('PLAN_STEP_MISSING', '新码'), AGENT_MAKE_PLAN)
    const h = openHarness(send)
    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(false)
    if (out.ok) return
    // IpcErrorCode 是闭合联合：Python 新加的码没在 error-code.ts 登记就漏到 UI，
    // 前端会拿到一个查不到含义的字符串。
    expect(out.code).toBe(RUNTIME_ERROR_CODE.CRASHED)
    expect(out.message).toContain('新码')
  })
})

describe('MAKE_PLAN_TIMEOUT_MS', () => {
  it('钉住字面值，且必须比 run_task 短', () => {
    expect(MAKE_PLAN_TIMEOUT_MS).toBe(10_000)
    // 计划是纯计算，真卡住要早报错。跟 run_task 用同一个值的话，
    // 库里连 Task 都没有的那段时间会被拖到 120 秒。
    expect(MAKE_PLAN_TIMEOUT_MS).toBeLessThan(RUN_TASK_TIMEOUT_MS)
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

describe('runTask：任务槽位（ActionAlignment 的比对基准）', () => {
  /** 等到条件成立。runTask 里有两个 await 才走到 beginTask，
   *  数微任务的个数等于把内部实现钉进测试，所以轮询。 */
  async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
    if (!cond()) throw new Error('等待超时')
  }

  /** 把 resolve 带出 Promise 构造器。用 `let release: (() => void) | null`
   *  写在测试里的话，TS 看不到回调里的赋值，会把变量窄成 null。 */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  it('run_task 期间 host 侧看得见当前任务，内容就是 make_plan 的回包', async () => {
    // 这条是整条链的接头：Python 回来的 host.execute_tool 靠它拿计划。
    // 看不到或看到的是别人的计划，ActionAlignment 就没得比。
    const h = openHarness()
    // 用数组接快照而不是用 let 变量：赋值发生在回调里，
    // TS 的控制流分析会把后者窄成 null，读的时候变成 never。
    const snapshots: ActiveTask[] = []
    h.send = (method) => {
      if (method === AGENT_RUN_TASK) {
        const task = currentTask()
        if (task !== null) snapshots.push(task)
        return Promise.resolve(completedResult())
      }
      return Promise.resolve(planResult())
    }

    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(true)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.taskId).toBe('id-1')
    expect(snapshots[0]?.goal).toBe(GOAL)
    expect(snapshots[0]?.plan).toEqual(PLAN_STEPS)
    expect(snapshots[0]?.executedCalls).toBe(0)
  })

  it('成功返回后槽位让出来，下一次 runTask 能直接开始', async () => {
    const h = openHarness()

    expect((await runTask(GOAL, h)).ok).toBe(true)
    expect(currentTask()).toBeNull()
    expect((await runTask(GOAL, h)).ok).toBe(true)
    expect(currentTask()).toBeNull()
    expect(h.tasks.findAll()).toHaveLength(2)
  })

  it('run_task 抛错时也让出槽位（finally，不是正常路径才管）', async () => {
    const h = openHarness(sendThrowing(new RuntimeError('BUDGET_EXHAUSTED', '预算耗尽')))

    const out = await runTask(GOAL, h)

    expect(out.ok && out.status).toBe('failed')
    expect(currentTask()).toBeNull()
  })

  it('回包不合契约时也让出槽位', async () => {
    const h = openHarness(sendReturning({ status: 'weird' }))

    const out = await runTask(GOAL, h)

    // RESPONSE_INVALID 走的是 persistRuntimeFailure，对外仍是 ok:true + status:failed，
    // 码落在 task_failed 事件的 payload 里。
    expect(out.ok && out.status).toBe('failed')
    expect(currentTask()).toBeNull()
  })

  it('事务 A 失败时也让出槽位，而且库里不留 Task', async () => {
    // beginTask 排在事务 A 之前，所以这条路径上槽位已经占了。
    // 占了不让的话，一次写库失败就把整个应用锁死在 TASK_BUSY 上。
    const h = openHarness()
    h.tasks = {
      ...h.tasks,
      insert: () => {
        throw new Error('DB 坏了')
      }
    }

    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe(RUNTIME_ERROR_CODE.DB_FAILED)
    expect(currentTask()).toBeNull()
  })

  it('索要计划失败时根本没占槽', async () => {
    // 拿不到计划就是任务从没开始，不该把槽位扣住。
    const h = openHarness(
      sendThrowing(new RuntimeError('PLAN_NOT_BUILDABLE', '缺能力'), AGENT_MAKE_PLAN)
    )

    const out = await runTask(GOAL, h)

    expect(out.ok).toBe(false)
    expect(currentTask()).toBeNull()
  })

  it('并发：第二个 runTask 得到 TASK_BUSY，且库里只留一条 Task', async () => {
    const gate = deferred()
    const h = openHarness()
    h.send = (method) =>
      method === AGENT_RUN_TASK
        ? gate.promise.then(() => completedResult())
        : Promise.resolve(planResult())

    const first = runTask(GOAL, h)
    await waitFor(() => currentTask() !== null)

    const second = await runTask('另一个目标', h)

    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.code).toBe(RUNTIME_ERROR_CODE.TASK_BUSY)
      // 消息里带正在跑的 taskId：UI 上只看到「有任务在跑」是查不下去的。
      expect(second.message).toContain('id-1')
    }
    // 第二个任务一条库都没写：TASK_BUSY 发生在事务 A 之前。
    expect(h.tasks.findAll()).toHaveLength(1)

    gate.resolve()
    expect((await first).ok).toBe(true)
    expect(currentTask()).toBeNull()
  })
})
