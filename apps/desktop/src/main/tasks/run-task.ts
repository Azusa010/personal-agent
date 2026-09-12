import { AGENT_RUN_TASK, ERROR_CODE, RunTaskParams, RunTaskResult } from '@personal-agent/protocol'
import type { RunTaskIpcResult } from '../../shared/ipc-contract'
import type { SqliteDatabase } from '../product-state/database'
import type { EventRepository } from '../product-state/event-repository'
import type { PlanRepository } from '../product-state/plan-repository'
import type { TaskRepository } from '../product-state/task-repository'
import { PHASE1_PLAN_STEPS } from './plan-template'
import { RuntimeError } from '../runtime/python-supervisor'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'

// 界：Budget 默认 maxToolCalls=5，每次 host 调用最坏 hostTimeoutMs=5000，
// 工具时间上界 25 秒。ScriptedModel 决策耗时约 0，接真实模型后每步 2-10 秒
// × maxSteps=8 = 16-80 秒。supervisor 的 defaultTimeoutMs 是 30000，不够。
// Budget 在 Python 侧、契约里不传（3b 钉死 RunTaskParams 只有 taskId/goal），
// 所以这个值只能硬编码，由 run-task.test.ts 的钉值测试守住不等式。
export const RUN_TASK_TIMEOUT_MS = 120_000

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
  // 跑一个完整的完整编排：建 Task → 写 Plan → 调 Python → 落 events → 推状态。
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
        steps: [...PHASE1_PLAN_STEPS],
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
