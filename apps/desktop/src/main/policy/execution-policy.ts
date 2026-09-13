import {
  ERROR_CODE,
  type CapabilityDescriptor,
  type HostExecuteToolParams
} from '@personal-agent/protocol'

import type { ToolRetriever } from '../capabilities/retriever'
import type { TaskScope } from '../capabilities/scope'
import { checkAlignment } from './alignment'
import { bindArguments, type BoundArgs } from './argument-binders'
import { assessRisk } from './risk'
import { currentTask, recordExecutedCall } from './task-context'

export type CallOrigin = { readonly kind: 'agent' } | { readonly kind: 'ui' }

/** 调用从哪里来。两条入口的判定必须不同：
 */
export const AGENT_ORIGIN: CallOrigin = { kind: 'agent' }
export const UI_ORIGIN: CallOrigin = { kind: 'ui' }

export interface AuthorizedCall {
  readonly callId: string
  readonly capability: CapabilityDescriptor
  readonly bound: BoundArgs
  readonly taskId: string
}

export type PolicyDecision =
  | { readonly allowed: true; readonly call: AuthorizedCall }
  | { readonly allowed: false; readonly code: string; readonly reason: string }

function deny(code: string, reason: string): PolicyDecision {
  return { allowed: false, code, reason }
}

// 依赖
export interface ExecutionPolicyDeps {
  readonly scope: TaskScope
  readonly retriever: ToolRetriever
  readonly origin: CallOrigin
}

export interface ExecutionPolicy {
  evaluate(params: HostExecuteToolParams): Promise<PolicyDecision>
}

/**
 * 八级检验管道
 */
export function createExecutionPolicy(deps: ExecutionPolicyDeps): ExecutionPolicy {
  return {
    evaluate: async (params) => {
      // ① 已注册 ② 在 Scope。两个码分开：NOT_REGISTERED 是模型幻觉出一个
      // 不存在的工具，OUT_OF_SCOPE 是工具存在但这个任务不许用。
      const auth = deps.retriever.authorize(deps.scope, params.capability)
      if (!auth.allowed) {
        return deny(auth.code, auth.reason)
      }

      // ③ 有当前任务 ④ 对齐计划。只对 agent：UI 没有计划可比。
      if (deps.origin.kind === 'agent') {
        const task = currentTask()
        if (task === null) {
          return deny(
            ERROR_CODE.NO_ACTIVE_TASK,
            `没有进行中的任务，无法核对 ${params.capability} 是否在计划里`
          )
        }
        const aligned = checkAlignment(task.plan, task.executedCalls, params.capability)
        if (!aligned.aligned) {
          return deny(ERROR_CODE.ACTION_NOT_ALIGNED, aligned.reason)
        }
      }

      // ⑤ 风险。纯查表
      const risk = assessRisk(auth.capability)
      if (risk.level === 'PERMISSION_REQUIRED') {
        return deny(ERROR_CODE.PERMISSION_REQUIRED, risk.reason)
      }

      // ⑥ 参数契约 ⑦ 路径规范化与 root guard。
      const bound = await bindArguments(params.capability, params.arguments)
      if (!bound.ok) {
        return deny(bound.code, bound.reason)
      }

      // ⑧ 放行。计数必须在所有拒绝之后：被拒的调用不占序号
      if (deps.origin.kind === 'agent') {
        recordExecutedCall()
      }

      return {
        allowed: true,
        call: {
          callId: params.callId,
          capability: auth.capability,
          bound: bound.bound,
          taskId: deps.scope.taskId
        }
      }
    }
  }
}
