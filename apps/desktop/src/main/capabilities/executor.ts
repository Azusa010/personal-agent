import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'

import {
  createExecutionPolicy,
  type AuthorizedCall,
  type CallOrigin,
  type PermissionGate,
  type TaskStatePort
} from '../policy/execution-policy'
import type { ToolExecutionRepository } from '../product-state/tool-execution-repository'
import { evaluateCallSafety } from '../policy/sidecar'
import { afterExecute, beginAttempt, isWriteCapability, type IdempotencyDeps } from './idempotency'
import { RuleBasedToolRetriever, type ToolRetriever } from './retriever'
import type { TaskScope } from './scope'
import {
  getCapabilityPlugin,
  fail,
  REMINDER_CREATED_EVENT,
  KNOWLEDGE_ISOLATION_HEADER,
  KNOWLEDGE_ISOLATION_FOOTER,
  USER_MEMORY_ISOLATION_HEADER,
  USER_MEMORY_ISOLATION_FOOTER,
  VIKING_ISOLATION_HEADER,
  VIKING_ISOLATION_FOOTER,
  wrapExternalSource,
  type CapabilityOutcome,
  type ExecutorSchedulerWiring,
  type ExecutorKnowledgeWiring,
  type ExecutorMemoryWiring
} from './plugins'

export type {
  CapabilityOutcome,
  ExecutorSchedulerWiring,
  ExecutorKnowledgeWiring,
  ExecutorMemoryWiring
}

export {
  REMINDER_CREATED_EVENT,
  KNOWLEDGE_ISOLATION_HEADER,
  KNOWLEDGE_ISOLATION_FOOTER,
  USER_MEMORY_ISOLATION_HEADER,
  USER_MEMORY_ISOLATION_FOOTER,
  VIKING_ISOLATION_HEADER,
  VIKING_ISOLATION_FOOTER,
  wrapExternalSource
}

/** 批准通道的集成。 */
export interface ExecutorPermissionWiring {
  readonly gate: PermissionGate
  readonly tasks?: TaskStatePort
  readonly now?: () => string
}

/** 幂等关的集成。不传就是没有幂等保护：WRITE 能力照常执行但不登记、不查重复。
 */
export interface ExecutorIdempotencyWiring {
  readonly executions: ToolExecutionRepository
  readonly now?: () => string
}

export function createExecutor(
  scope: TaskScope,
  origin: CallOrigin,
  retriever: ToolRetriever = new RuleBasedToolRetriever(),
  permission?: ExecutorPermissionWiring,
  idempotency?: ExecutorIdempotencyWiring,
  scheduler?: ExecutorSchedulerWiring,
  knowledge?: ExecutorKnowledgeWiring,
  memory?: ExecutorMemoryWiring
): (params: HostExecuteToolParams) => Promise<CapabilityOutcome> {
  const policy = createExecutionPolicy({
    scope,
    retriever,
    origin,
    permissions: permission?.gate,
    tasks: permission?.tasks,
    now: permission?.now
  })
  return async (params) => {
    const decision = await policy.evaluate(params)
    if (!decision.allowed) {
      return fail(decision.code, decision.reason)
    }

    const action = evaluateCallSafety(params.capability, params.arguments, params.callId)
    if (action.kind !== 'allow') {
      return fail(ERROR_CODE.PERMISSION_DENIED, action.reason || '安全策略违规')
    }

    const call = decision.call
    // 没接幂等 store，或不是 WRITE 能力（只读无副作用）→ 直接执行，维持原行为。
    // scheduler_create 虽是 WRITE 但不进这道关：它的副作用是库内一行而不是
    // 文件系统，reminders.task_id UNIQUE + 执行体内按 idempotencyKey 比对已经
    // 覆盖了「同参重试幂等返回、异参拒绝」，没有需要 recovery resolver 复查的中间态。
    if (idempotency === undefined || !isWriteCapability(call.capability.name)) {
      return runCapability(call, scheduler, knowledge, memory)
    }
    // WRITE 能力过幂等关：执行前查重复决定跑不跑，执行后把 attempting 翻成终态。
    const deps: IdempotencyDeps = { executions: idempotency.executions, now: idempotency.now }
    const before = await beginAttempt(deps, call)
    if (before.kind !== 'proceed') {
      // skip（已成功）或 reject（矛盾态）都直接返回结果，不跑副作用。
      return before.result
    }
    const outcome = await runCapability(call, scheduler, knowledge, memory)
    afterExecute(deps, before.key, outcome)
    return outcome
  }
}

/**
 * 副作用执行体：委托给自描述能力插件 (CapabilityPlugin.execute)。
 */
async function runCapability(
  call: AuthorizedCall,
  scheduler?: ExecutorSchedulerWiring,
  knowledge?: ExecutorKnowledgeWiring,
  memory?: ExecutorMemoryWiring
): Promise<CapabilityOutcome> {
  const plugin = getCapabilityPlugin(call.capability.name)
  if (plugin === undefined) {
    return fail(ERROR_CODE.NOT_IMPLEMENTED, `执行体未实现: ${call.capability.name}`)
  }
  return plugin.execute(call, { scheduler, knowledge, memory })
}
