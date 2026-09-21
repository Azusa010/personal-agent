import {
  AGENT_RUN_WORKFLOW,
  ERROR_CODE,
  RunTaskResult,
  RunWorkflowParams
} from '@personal-agent/protocol'
import type { PlanStep } from '../../shared/domain'
import type { RunWorkflowInput, RunWorkflowIpcResult } from '../../shared/ipc-contract'
import { beginTask, endTask, TaskBusyError } from '../policy/task-context'
import type { SqliteDatabase } from '../product-state/database'
import type { EventRepository } from '../product-state/event-repository'
import type { PlanRepository } from '../product-state/plan-repository'
import type { TaskRepository } from '../product-state/task-repository'
import { RuntimeError } from '../runtime/python-supervisor'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'

const TASK_FAILED_EVENT = 'task_failed'

export const RUN_WORKFLOW_TIMEOUT_MS = 120_000

export type RuntimeSend = (
  method: string,
  params: unknown,
  opts?: { timeoutMs?: number }
) => Promise<unknown>

export interface WorkflowDefinition {
  id: string
  name: string
  goal: string
  description: string
  steps: readonly PlanStep[]
}

/** 静态工作流清单注册表 */
export const WORKFLOW_DEFINITIONS: Record<string, WorkflowDefinition> = {
  golden_path: {
    id: 'golden_path',
    name: '整理 Downloads 里的 PDF',
    goal: 'workflow:golden_path',
    description: '扫描、提取、归档并创建阅读提醒的标准确定性工作流',
    steps: [
      { description: '列出 Downloads 下的 PDF', capability: 'filesystem_list' },
      { description: '提取目标 PDF 的每页文本', capability: 'document_extract_pdf' },
      { description: '在 Downloads 下创建 Reading 目录', capability: 'filesystem_create_dir' },
      { description: '把选中的 PDF 移到 Reading', capability: 'filesystem_move' },
      { description: '创建一次性阅读提醒', capability: 'scheduler_create' }
    ]
  }
}

export interface RunWorkflowDeps {
  db: SqliteDatabase
  tasks: TaskRepository
  plans: PlanRepository
  events: EventRepository
  send: RuntimeSend
  now?: () => string
  newId?: () => string
}

function persistRuntimeFailure(
  deps: RunWorkflowDeps,
  taskId: string,
  code: string,
  message: string
): RunWorkflowIpcResult {
  const stamp = deps.now?.() ?? new Date().toISOString()
  try {
    const runFail = deps.db.transaction(() => {
      deps.events.append({
        taskId,
        type: TASK_FAILED_EVENT,
        payload: { code, message },
        occurredAt: stamp
      })
      deps.tasks.updateStatus(taskId, 'failed', stamp)
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

export async function runWorkflow(
  input: RunWorkflowInput,
  deps: RunWorkflowDeps
): Promise<RunWorkflowIpcResult> {
  const definition = WORKFLOW_DEFINITIONS[input.workflowId]
  if (!definition) {
    return {
      ok: false,
      code: ERROR_CODE.INVALID_ARGUMENT,
      message: `未知工作流: ${input.workflowId}`
    }
  }

  const taskId = deps.newId?.() ?? crypto.randomUUID()
  const planId = deps.newId?.() ?? crypto.randomUUID()
  const now = deps.now?.() ?? new Date().toISOString()

  const parsedParams = RunWorkflowParams.safeParse({
    taskId,
    workflowId: input.workflowId,
    inputs: input.inputs ?? {}
  })
  if (!parsedParams.success) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: parsedParams.error.message
    }
  }

  try {
    beginTask(taskId, definition.goal, definition.steps)
  } catch (e) {
    if (e instanceof TaskBusyError) {
      return { ok: false, code: RUNTIME_ERROR_CODE.TASK_BUSY, message: e.message }
    }
    throw e
  }

  try {
    // 事务 A：写入 TaskRecord 与静态 PlanRecord
    try {
      const runA = deps.db.transaction(() => {
        deps.tasks.insert({
          id: taskId,
          goal: definition.goal,
          status: 'pending',
          createdAt: now,
          updatedAt: now
        })
        deps.tasks.updateStatus(taskId, 'running', now)
        deps.plans.append({
          id: planId,
          taskId,
          steps: [...definition.steps],
          createdAt: now
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

    // 调用底层 Python 运行时
    let rawResult: unknown
    try {
      rawResult = await deps.send(AGENT_RUN_WORKFLOW, parsedParams.data, {
        timeoutMs: RUN_WORKFLOW_TIMEOUT_MS
      })
    } catch (e) {
      const code = e instanceof RuntimeError ? e.code : RUNTIME_ERROR_CODE.CRASHED
      const message = e instanceof Error ? e.message : String(e)
      return persistRuntimeFailure(deps, taskId, code, message)
    }

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
    const stamp = deps.now?.() ?? new Date().toISOString()

    // 事务 B：将 events 与终态落库
    try {
      const runB = deps.db.transaction(() => {
        for (const ev of result.events) {
          deps.events.append({ taskId, ...ev })
        }
        deps.tasks.updateStatus(taskId, result.status, stamp)
      })
      runB()
    } catch (e) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: e instanceof Error ? e.message : String(e)
      }
    }

    if (result.status === 'completed') {
      return {
        ok: true,
        taskId,
        status: 'completed',
        reply: result.reply,
        facts: result.facts
      }
    } else {
      return {
        ok: true,
        taskId,
        status: 'failed',
        reason: result.reason
      }
    }
  } finally {
    endTask()
  }
}
