import {
  AGENT_MAKE_PLAN,
  AGENT_RUN_TASK,
  ERROR_CODE,
  MakePlanResult,
  RunTaskParams,
  RunTaskResult
} from '@personal-agent/protocol'
import type { IpcErrorCode, RunTaskIpcResult } from '../../shared/ipc-contract'
import type { PlanStep } from '../../shared/domain'
import { beginTask, endTask, TaskBusyError } from '../policy/task-context'
import type { SqliteDatabase } from '../product-state/database'
import type { EventRepository } from '../product-state/event-repository'
import type { PlanRepository } from '../product-state/plan-repository'
import type { TaskRepository } from '../product-state/task-repository'
import { RuntimeError } from '../runtime/python-supervisor'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'

// 界：Budget 默认 maxToolCalls=5，每次 host 调用最坏 hostTimeoutMs=5000，
// 工具时间上界 25 秒。ScriptedModel 决策耗时约 0，接真实模型后每步 2-10 秒
// × maxSteps=8 = 16-80 秒。supervisor 的 defaultTimeoutMs 是 30000，不够。
// Budget 在 Python 侧、契约里不传（3b 钉死 RunTaskParams 只有 taskId/goal），
// 所以这个值只能硬编码，由 run-task.test.ts 的钉值测试守住不等式。
export const RUN_TASK_TIMEOUT_MS = 120_000

// agent.make_plan 是纯计算（查一次能力清单 + 返回固定三步），10 秒已经宽得离谱。
// 真超过就是子进程卡死或 stdout 堵了，早点报错比跟着等 120 秒强：
// 那 120 秒里库里连一条 Task 都没有，UI 上什么都看不见。
export const MAKE_PLAN_TIMEOUT_MS = 10_000

// supervisor 把 error envelope 里的 code 原样塞进 RuntimeError.code（类型是 string），
// 而 IPC 返回值的 code 是闭合联合。认得出的原样透传，认不出的收成 CRASHED——
// 那种情况是 Python 新加了码没在 error-code.ts 登记，让它显式变成可识别的码，
// 比把一个 UI 查不到的字符串推上去好。
const KNOWN_IPC_CODES: ReadonlySet<IpcErrorCode> = new Set<IpcErrorCode>([
  ...Object.values(RUNTIME_ERROR_CODE),
  ...Object.values(ERROR_CODE)
])

function toIpcCode(code: string): IpcErrorCode {
  const known = code as IpcErrorCode
  return KNOWN_IPC_CODES.has(known) ? known : RUNTIME_ERROR_CODE.CRASHED
}

/** runtime-host 的窄网关形状。测试注入 stub，生产传 requestRuntime。 */
export type RuntimeSend = (
  method: string,
  params: unknown,
  opts?: { timeoutMs?: number }
) => Promise<unknown>

// 运行任务的依赖
export interface RunTaskDeps {
  db: SqliteDatabase
  tasks: TaskRepository
  plans: PlanRepository
  events: EventRepository
  send: RuntimeSend
  /** 默认 new Date().toISOString()，格式与 RunTaskEvent.occurredAt 一致 */
  now?: () => string
  /** 默认 node:crypto 的 randomUUID */
  newId?: () => string
}

function persistRuntimeFailure(
  deps: RunTaskDeps,
  taskId: string,
  code: string,
  message: string
): RunTaskIpcResult {
  try {
    const runFail = deps.db.transaction(() => {
      deps.events.append({
        taskId,
        type: 'task_failed',
        payload: { code, message },
        occurredAt: deps.now?.() ?? new Date().toISOString()
      })
      deps.tasks.updateStatus(taskId, 'failed', deps.now?.() ?? new Date().toISOString())
    })
    runFail()
  } catch (e) {
    return {
      ok: false,
      code: RUNTIME_ERROR_CODE.DB_FAILED,
      message: e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: true, taskId, status: 'failed', reason: message }
}

export async function runTask(goal: unknown, deps: RunTaskDeps): Promise<RunTaskIpcResult> {
  // 跑一个完整的编排：索要计划 → 建 Task → 写 Plan → 调 Python → 落 events → 推状态。
  const taskId = deps.newId?.() ?? crypto.randomUUID()
  const planId = deps.newId?.() ?? crypto.randomUUID()
  const parsedParams = RunTaskParams.safeParse({ taskId, goal })
  if (!parsedParams.success) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: parsedParams.error.message
    }
  }
  const request = parsedParams.data

  // 计划在建 Task 之前索要：拿不到计划就是任务从没开始，库里不该留一条
  // 永远停在 pending 的 Task——reconcileOrphanTasks 只收 running 的，收了也不会动它。
  // MakePlanParams 与 RunTaskParams 字段逐字相同（envelope.test.ts 钉着），所以 request 直接复用。
  let rawPlan: unknown
  try {
    rawPlan = await deps.send(AGENT_MAKE_PLAN, request, { timeoutMs: MAKE_PLAN_TIMEOUT_MS })
  } catch (e) {
    // PLAN_NOT_BUILDABLE 走这条路：supervisor 把 error envelope 转成 RuntimeError，
    // code 原样透传给 UI，TS 不替 Python 改写错误语义。
    return {
      ok: false,
      code: e instanceof RuntimeError ? toIpcCode(e.code) : RUNTIME_ERROR_CODE.CRASHED,
      message: e instanceof Error ? e.message : String(e)
    }
  }
  const parsedPlan = MakePlanResult.safeParse(rawPlan)
  if (!parsedPlan.success) {
    return {
      ok: false,
      code: RUNTIME_ERROR_CODE.PLAN_INVALID,
      message: parsedPlan.error.message
    }
  }
  // 顺序原样落库：ActionAlignment 要拿计划里第 i 个带 capability 的步骤去比对
  // 第 i 次 tool call，这里裁剪或重排就等于把比对基准改了。
  const steps = parsedPlan.data.steps

  try {
    beginTask(taskId, request.goal, steps)
  } catch (e) {
    if (e instanceof TaskBusyError) {
      return { ok: false, code: RUNTIME_ERROR_CODE.TASK_BUSY, message: e.message }
    }
    throw e
  }

  // ActionAlignment 的比对基准从这里生效：接下来 agent.run_task 回来的每一次
  // host.execute_tool 都要按这份计划排队。endTask 必须放 finally：Python 崩了、
  try {
    return await runAgentPhase(taskId, planId, request, steps, deps)
  } finally {
    endTask()
  }
}

/** 占槽之后的全部流程：事务 A（建 Task + 写 Plan）→ agent.run_task → 事务 B。
 *  拆出来的唯一理由是让 endTask 有一个干净的 finally 可挂。 */
async function runAgentPhase(
  taskId: string,
  planId: string,
  request: RunTaskParams,
  steps: readonly PlanStep[],
  deps: RunTaskDeps
): Promise<RunTaskIpcResult> {
  // 事务 A:
  // insert Pending -> running ->append plan
  try {
    const runA = deps.db.transaction(() => {
      deps.tasks.insert({
        id: taskId,
        goal: request.goal,
        status: 'pending',
        createdAt: deps.now?.() ?? new Date().toISOString(),
        updatedAt: deps.now?.() ?? new Date().toISOString()
      })
      deps.tasks.updateStatus(taskId, 'running', deps.now?.() ?? new Date().toISOString())
      deps.plans.append({
        id: planId,
        taskId,
        steps: [...steps],
        createdAt: deps.now?.() ?? new Date().toISOString()
      })
    })
    runA()
  } catch (e) {
    return {
      ok: false,
      code: RUNTIME_ERROR_CODE.DB_FAILED,
      message: e instanceof Error ? e.message : String(e)
    }
  }

  let rawResult: unknown
  try {
    rawResult = await deps.send(AGENT_RUN_TASK, request, { timeoutMs: RUN_TASK_TIMEOUT_MS })
  } catch (e) {
    const code = e instanceof RuntimeError ? e.code : RUNTIME_ERROR_CODE.CRASHED
    return persistRuntimeFailure(deps, taskId, code, e instanceof Error ? e.message : String(e))
  }

  // 事务 B:
  const parsedResult = RunTaskResult.safeParse(rawResult)
  if (!parsedResult.success) {
    return persistRuntimeFailure(
      deps,
      taskId,
      RUNTIME_ERROR_CODE.RESPONSE_INVALID,
      parsedResult.error.message
    )
  }
  const result = parsedResult.data
  const { status, events } = result

  try {
    const runB = deps.db.transaction(() => {
      for (const ev of events) {
        deps.events.append({ taskId, ...ev })
      }
      deps.tasks.updateStatus(taskId, status, deps.now?.() ?? new Date().toISOString())
    })
    runB()
  } catch (e) {
    return {
      ok: false,
      code: RUNTIME_ERROR_CODE.DB_FAILED,
      message: e instanceof Error ? e.message : String(e)
    }
  }

  return result.status === 'completed'
    ? { ok: true, taskId, status: 'completed', facts: result.facts }
    : { ok: true, taskId, status: 'failed', reason: result.reason }
}
