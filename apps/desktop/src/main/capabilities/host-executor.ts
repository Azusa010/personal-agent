import {
  ERROR_CODE,
  HostExecuteToolParams,
  type CapabilityDescriptor
} from '@personal-agent/protocol'

import { AGENT_ORIGIN, UI_ORIGIN } from '../policy/execution-policy'
import { currentTask } from '../policy/task-context'
import {
  createExecutor,
  type CapabilityOutcome,
  type ExecutorIdempotencyWiring,
  type ExecutorKnowledgeWiring,
  type ExecutorPermissionWiring,
  type ExecutorSchedulerWiring
} from './executor'
import { RuleBasedToolRetriever } from './retriever'
import { agentTaskScope, readOnlyScope } from './scope'

/**
 * 两个网关，两套 Scope（TASK-028 起不再共用）：
 *
 *   - agent 那条（executeHostTool）：Scope 按**当前任务**现取，含三个 WRITE；
 *     权限、幂等、调度三组依赖由 index.ts 启动时注入。
 *   - ui 那条（executeCapability）：renderer 发起，没有任务上下文，只读 Scope、
 *     不挂接线——界面上能做的只有列举与索引。
 */

const BOOTSTRAP_TASK_ID = 'bootstrap'

/** 生产接线（TASK-028）。在 index.ts 启动时注入；测试里可以整体换成假件。
 *
 *  不注入时 WRITE 能力会被拒（PERMISSION_REQUIRED）而不是静默放行——「没接线」
 *  必须是一次看得见的失败，这与 executor 里 scheduler 未接线时回 NOT_IMPLEMENTED
 *  是同一条规矩。 */
export interface HostExecutorWiring {
  readonly permission?: ExecutorPermissionWiring
  readonly idempotency?: ExecutorIdempotencyWiring
  readonly scheduler?: ExecutorSchedulerWiring
  readonly knowledge?: ExecutorKnowledgeWiring
}

let wiring: HostExecutorWiring = {}

export function configureHostExecutor(next: HostExecutorWiring): void {
  wiring = next
}

/** 测试收尾用：把接线还原成「什么都没接」，避免一个文件的接线漏到下一个文件。 */
export function resetHostExecutorWiring(): void {
  wiring = {}
}

const retriever = new RuleBasedToolRetriever()

let ipcCounter = 0

// 下发给 Python 的清单必须与 agent 那条实际放行的是同一份能力表，否则模型看见的
// 能力和它真正能调的能力会分叉（多了会反复提一个永远被拒的能力，少了就没法按计划
// 走完）。这里用同一个 agentTaskScope 生成，只差 taskId。
export function listVisibleCapabilities(): readonly CapabilityDescriptor[] {
  return retriever.listVisible(agentTaskScope(BOOTSTRAP_TASK_ID))
}

/**
 * 只读清单：`filesystem_list` 与 `document_extract_pdf`。
 *
 * 给「只跑读链路」的入口用——Live Eval 的 20 条 Case 就是这种配置（它量的是文档
 * 摘要，不该被要求移动文件、建 Reminder）。握手时下发什么，Python 的 make_plan
 * 就按它生成计划，交付物闸口再按计划推导要求，所以这里少给两个能力，整条链路的
 * 要求会一起收窄，不会出现「计划三步、闸口要五步」的错位。
 */
export function listReadOnlyCapabilities(): readonly CapabilityDescriptor[] {
  return retriever.listVisible(readOnlyScope(BOOTSTRAP_TASK_ID))
}

// 给 PythonSupervisor 的 hostHandler。只有 run-task.ts beginTask 之后才放行。
export async function executeHostTool(params: HostExecuteToolParams): Promise<CapabilityOutcome> {
  // Scope 每次现取而不是建一个单例：scope.taskId 是权限记录、任务状态回推与幂等表
  // 三处的归属键，用固定值会把三种记录全挂到一个不存在的任务上。per-task 重建
  // executor 只多一个闭包，代价可以忽略。
  //
  // 没有当前任务时这里传哨兵 id，让 policy 的第一关（有没有任务、是否对齐计划）
  // 去拒——它是这条路径唯一该拒的地方，不在这里抢答。
  const scope = agentTaskScope(currentTask()?.taskId ?? BOOTSTRAP_TASK_ID)
  return createExecutor(
    scope,
    AGENT_ORIGIN,
    retriever,
    wiring.permission,
    wiring.idempotency,
    wiring.scheduler,
    wiring.knowledge
  )(params)
}

// 给IPC的网关。renderer 没有任务上下文，所以走 ui origin：
// 注册、Scope、风险、契约、路径五关照过，只是不拿计划对齐。
export async function executeCapability(
  capability: string,
  args: Record<string, unknown>
): Promise<CapabilityOutcome> {
  ipcCounter += 1
  const parsed = HostExecuteToolParams.safeParse({
    callId: `ipc-${ipcCounter}`,
    capability,
    arguments: args
  })
  if (!parsed.success) {
    return {
      ok: false,
      code: ERROR_CODE.INVALID_ARGUMENT,
      reason: `capability 或 arguments 不符合契约: ${parsed.error.message}`
    }
  }
  return createExecutor(
    readOnlyScope(BOOTSTRAP_TASK_ID),
    UI_ORIGIN,
    retriever,
    wiring.permission,
    wiring.idempotency,
    wiring.scheduler,
    wiring.knowledge
  )(parsed.data)
}
