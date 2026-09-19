import { randomUUID } from 'node:crypto'
import {
  AGENT_MAKE_PLAN,
  AGENT_RUN_TASK,
  ERROR_CODE,
  MakePlanResult,
  RunTaskParams,
  MakePlanParams,
  RunTaskResult,
  type SummaryFact,
  Turn,
  ProfileDto
} from '@personal-agent/protocol'
import type { IpcErrorCode, RunTaskIpcResult } from '../../shared/ipc-contract'
import type { PlanStep } from '../../shared/domain'
import { beginTask, endTask, TaskBusyError, updateActiveTaskPlan } from '../policy/task-context'
import type { SqliteDatabase } from '../product-state/database'
import type { EventRepository } from '../product-state/event-repository'
import type { PlanRepository } from '../product-state/plan-repository'
import type { TaskRepository } from '../product-state/task-repository'
import { onAgentStream } from '../runtime/stream-fanout'
import { RuntimeError } from '../runtime/python-supervisor'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'
import { RUN_TASK_TIMEOUT_MS } from '../runtime/timeouts'
import {
  VERIFICATION_FAILED_EVENT,
  VERIFICATION_PASSED_EVENT,
  VERIFICATION_STARTED_EVENT
} from '../verification/verify-deliverables'
import type { CompletionVerifier, VerificationOutcome } from '../verification/verify-task'
import { AgentProfile } from '../settings/agent-profile'

// reconcile.ts 也用这个字面量：任务的失败原因落成事件，UI 与诊断都读它。
const TASK_FAILED_EVENT = 'task_failed'

export const MAKE_PLAN_TIMEOUT_MS = 60_000

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
  verify: CompletionVerifier
  profile?: () => AgentProfile | null
  /** 默认 new Date().toISOString()，格式与 RunTaskEvent.occurredAt 一致 */
  now?: () => string
  /** 默认 node:crypto 的 randomUUID */
  newId?: () => string
}

function dbFailed(e: unknown): RunTaskIpcResult {
  return {
    ok: false,
    code: RUNTIME_ERROR_CODE.DB_FAILED,
    message: e instanceof Error ? e.message : String(e)
  }
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
        type: TASK_FAILED_EVENT,
        payload: { code, message },
        occurredAt: deps.now?.() ?? new Date().toISOString()
      })
      deps.tasks.updateStatus(taskId, 'failed', deps.now?.() ?? new Date().toISOString())
    })
    runFail()
  } catch (e) {
    return dbFailed(e)
  }
  return { ok: true, taskId, status: 'failed', reason: message }
}

export async function runTask(
  goal: unknown,
  deps: RunTaskDeps,
  history: Turn[] = []
): Promise<RunTaskIpcResult> {
  const taskId = deps.newId?.() ?? crypto.randomUUID()
  const planId = deps.newId?.() ?? crypto.randomUUID()

  const currentProfile = deps.profile?.() ?? null
  const profileDto: ProfileDto | undefined = currentProfile
    ? {
        name: currentProfile.name,
        persona: currentProfile.persona,
        reasoningSummary: currentProfile.reasoningSummary
      }
    : undefined

  const parsedPlanParams = MakePlanParams.safeParse({
    taskId,
    goal,
    history,
    ...(profileDto ? { profile: profileDto } : {})
  })
  if (!parsedPlanParams.success) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: parsedPlanParams.error.message
    }
  }
  let rawPlan: unknown
  try {
    rawPlan = await deps.send(AGENT_MAKE_PLAN, parsedPlanParams.data, {
      timeoutMs: MAKE_PLAN_TIMEOUT_MS
    })
  } catch (e) {
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
  const steps = parsedPlan.data.steps
  const parsedParams = RunTaskParams.safeParse({
    taskId,
    goal,
    plan: steps,
    history,
    ...(profileDto ? { profile: profileDto } : {})
  })
  if (!parsedParams.success) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: parsedParams.error.message
    }
  }
  const request = parsedParams.data

  try {
    beginTask(taskId, request.goal, steps)
  } catch (e) {
    if (e instanceof TaskBusyError) {
      return { ok: false, code: RUNTIME_ERROR_CODE.TASK_BUSY, message: e.message }
    }
    throw e
  }

  try {
    return await runAgentPhase(taskId, planId, request, steps, deps)
  } finally {
    endTask()
  }
}

/** 占槽之后的全部流程：事务 A（建 Task + 写 Plan）→ agent.run_task →
 *  事务 B1（事件落库）→ 完成判定 → 事务 B2（校验报告 + 终态）。
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
    return dbFailed(e)
  }

  let rawResult: unknown
  const unsubscribeStream = onAgentStream((notice) => {
    if (
      notice.taskId === taskId &&
      notice.kind === 'event' &&
      notice.event.type === 'replan_completed'
    ) {
      const payload = notice.event.payload as { newPlan?: PlanStep[] } | null
      if (payload && Array.isArray(payload.newPlan)) {
        updateActiveTaskPlan(payload.newPlan)
        try {
          deps.plans.append({
            id: deps.newId?.() ?? randomUUID(),
            taskId,
            steps: payload.newPlan,
            createdAt: notice.event.occurredAt
          })
        } catch {
          // 容错：不影响主执行流
        }
      }
    }
  })

  try {
    rawResult = await deps.send(AGENT_RUN_TASK, request, { timeoutMs: RUN_TASK_TIMEOUT_MS })
  } catch (e) {
    const code = e instanceof RuntimeError ? e.code : RUNTIME_ERROR_CODE.CRASHED
    return persistRuntimeFailure(deps, taskId, code, e instanceof Error ? e.message : String(e))
  } finally {
    unsubscribeStream()
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
  const { events } = result
  const stamp = deps.now?.() ?? new Date().toISOString()

  // 补录/兜底：确保重规划产生的计划版本落库
  syncReplanPlans(deps, taskId, events)

  // failed 不经判定：没有交付物可验，Python 给的原因就是终态原因。
  if (result.status === 'failed') {
    try {
      const runFail = deps.db.transaction(() => {
        for (const ev of events) {
          deps.events.append({ taskId, ...ev })
        }
        deps.tasks.updateStatus(taskId, 'failed', stamp)
      })
      runFail()
    } catch (e) {
      return dbFailed(e)
    }
    return { ok: true, taskId, status: 'failed', reason: result.reason }
  }

  // 交付物验证可选化：无工具步骤的纯问答或纯摘要任务无需独立硬件/文件系统交付物校验
  const needsVerification = steps.some((step) => step.capability !== undefined)
  if (!needsVerification) {
    try {
      const runComplete = deps.db.transaction(() => {
        for (const ev of events) {
          deps.events.append({ taskId, ...ev })
        }
        deps.tasks.updateStatus(taskId, 'completed', stamp)
      })
      runComplete()
    } catch (e) {
      return dbFailed(e)
    }
    return { ok: true, taskId, status: 'completed', reply: result.reply, facts: result.facts }
  }

  // 事务 B1：Python 的事件落库 + 校验开始标记。状态**留在 running**——
  // completed 只能由判定表翻转（REQ-009 / PAT-003），Python 的 task_completed
  // 事件只是 Agent 侧的完成声明。
  try {
    const runB1 = deps.db.transaction(() => {
      for (const ev of events) {
        deps.events.append({ taskId, ...ev })
      }
      deps.events.append({
        taskId,
        type: VERIFICATION_STARTED_EVENT,
        payload: { factCount: result.facts.length },
        occurredAt: stamp
      })
    })
    runB1()
  } catch (e) {
    return dbFailed(e)
  }

  // 判定表要读库、读真实 PDF、读文件系统，塞不进 better-sqlite3 的同步事务，
  // 所以 B1 与 B2 之间有一小段 running 窗口。此刻崩溃的话任务成了孤儿，
  // 下次启动被 reconcileOrphanTasks 收成 failed——宁可失败，也不放行未校验的 completed。
  const outcome = await verifyCompletion(deps, taskId, result.facts)

  // 事务 B2：校验报告（与 Evidence Bundle）落库 + 终态翻转。
  const gate = GATE_OUTCOMES[outcome.report.ok ? 'passed' : 'refused']
  try {
    const runB2 = deps.db.transaction(() => {
      deps.events.append({
        taskId,
        type: gate.eventType,
        payload: { report: outcome.report, evidence: outcome.evidence },
        occurredAt: stamp
      })
      if (gate.extraTaskFailedEvent) {
        // 状态翻 failed 的同事务写一条 task_failed：UI 的失败原因与诊断都读它。
        deps.events.append({
          taskId,
          type: TASK_FAILED_EVENT,
          payload: {
            code: RUNTIME_ERROR_CODE.VERIFICATION_FAILED,
            message: verificationReason(outcome)
          },
          occurredAt: stamp
        })
      }
      deps.tasks.updateStatus(taskId, gate.status, stamp)
    })
    runB2()
  } catch (e) {
    return dbFailed(e)
  }

  return gate.status === 'completed'
    ? { ok: true, taskId, status: 'completed', reply: result.reply, facts: result.facts }
    : { ok: true, taskId, status: 'failed', reason: verificationReason(outcome) }
}

/**
 * 闸口结局 → 「写哪条事件、要不要补 task_failed、翻到哪个状态」。
 *
 * 三种结局里，「不通过」与「校验器异常」在 verifyCompletion 里已经合并成同一份
 * 未通过的报告（fail-closed），所以表只需要两行，IPC 回包也由 status 派生。
 * 加第四种结局（比如「证据不足，转人工」）时，改这一行表 + verifyCompletion
 * 的分流即可，主流程（B2 事务）不用动。
 */
interface GateOutcome {
  eventType: string
  /** 未通过时补一条 task_failed：UI 的失败行与诊断读它 */
  extraTaskFailedEvent: boolean
  status: 'completed' | 'failed'
}

const GATE_OUTCOMES: Record<'passed' | 'refused', GateOutcome> = {
  passed: {
    eventType: VERIFICATION_PASSED_EVENT,
    extraTaskFailedEvent: false,
    status: 'completed'
  },
  refused: { eventType: VERIFICATION_FAILED_EVENT, extraTaskFailedEvent: true, status: 'failed' }
}

/** 判定表异常一律按未通过处理：闸口坏了不能变成敞开的门。 */
async function verifyCompletion(
  deps: RunTaskDeps,
  taskId: string,
  facts: SummaryFact[]
): Promise<VerificationOutcome> {
  try {
    return await deps.verify({ taskId, facts })
  } catch (e) {
    return {
      report: {
        ok: false,
        checks: [],
        reason: `交付物校验器异常（按未通过处理）: ${e instanceof Error ? e.message : String(e)}`
      },
      evidence: null
    }
  }
}

function verificationReason(outcome: VerificationOutcome): string {
  return `交付物校验未通过: ${outcome.report.reason ?? '（判定表没给原因）'}`
}

function syncReplanPlans(
  deps: RunTaskDeps,
  taskId: string,
  events: readonly { type: string; payload: unknown; occurredAt: string }[]
): void {
  for (const ev of events) {
    if (ev.type === 'replan_completed' && typeof ev.payload === 'object' && ev.payload !== null) {
      const payload = ev.payload as { newPlan?: PlanStep[]; version?: number }
      if (Array.isArray(payload.newPlan)) {
        const currentCount = deps.plans.findAllVersions(taskId).length
        const targetVersion =
          typeof payload.version === 'number' ? payload.version : currentCount + 1
        if (targetVersion > currentCount) {
          deps.plans.append({
            id: deps.newId?.() ?? randomUUID(),
            taskId,
            steps: payload.newPlan,
            createdAt: ev.occurredAt
          })
          updateActiveTaskPlan(payload.newPlan)
        }
      }
    }
  }
}
