import {
  ERROR_CODE,
  type CapabilityDescriptor,
  type HostExecuteToolParams
} from '@personal-agent/protocol'

import type { ToolRetriever } from '../capabilities/retriever'
import type { TaskScope } from '../capabilities/scope'
import type { TaskStatus } from '../../shared/domain'
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

/** 挂起等批准的端口。形状与 permission-broker 的 request 一致
 */
export interface PermissionGate {
  request(input: {
    taskId: string
    toolCallId: string
    capability: string
    bound: BoundArgs
  }): Promise<PermissionGateOutcome>
  /** 六步验证。按 (taskId, toolCallId) 定位那条权限：callId 只在任务内有意义，
   *  只按它查会命中别的任务那条。 */
  verify(lookup: {
    taskId: string
    toolCallId: string
    bound: BoundArgs
  }): Promise<PermissionVerifyOutcome>
}

export type PermissionGateOutcome =
  | { readonly approved: true }
  | { readonly approved: false; readonly code: string; readonly reason: string }

/** 形状与 permission-broker 的 PermissionVerifyResult 一致，同样不反向 import。 */
export type PermissionVerifyOutcome =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string }

/** 挂起前后改任务状态。。 */
export interface TaskStatePort {
  updateStatus(id: string, status: TaskStatus, updatedAt: string): void
}

// 依赖
export interface ExecutionPolicyDeps {
  readonly scope: TaskScope
  readonly retriever: ToolRetriever
  readonly origin: CallOrigin
  /** 不传就是没有批准通道：WRITE 能力直接拒 */
  readonly permissions?: PermissionGate
  /** 挂起前后改任务状态。不传就不改 */
  readonly tasks?: TaskStatePort
  /** 默认 new Date().toISOString() */
  readonly now?: () => string
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

      // ⑥ 参数契约 ⑦ 路径规范化与 root guard。
      const bound = await bindArguments(params.capability, params.arguments)
      if (!bound.ok) {
        return deny(bound.code, bound.reason)
      }

      // ⑤ 风险与批准
      const risk = assessRisk(auth.capability)
      if (risk.level === 'PERMISSION_REQUIRED') {
        const gate = deps.permissions
        if (gate === undefined) {
          return deny(ERROR_CODE.PERMISSION_REQUIRED, risk.reason)
        }
        const outcome = await waitForPermission(deps, params, bound.bound)
        if (!outcome.approved) {
          return deny(outcome.code, outcome.reason)
        }

        const recheck = await gate.verify({
          taskId: deps.scope.taskId,
          toolCallId: params.callId,
          bound: bound.bound
        })
        if (!recheck.ok) {
          return deny(recheck.code, recheck.reason)
        }
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

/** 把任务标成等待批准、挂起、然后无论结论如何都推回 running。
 */
async function waitForPermission(
  deps: ExecutionPolicyDeps,
  params: HostExecuteToolParams,
  bound: BoundArgs
): Promise<PermissionGateOutcome> {
  const gate = deps.permissions
  if (gate === undefined) {
    throw new Error('waitForPermission 在没有批准通道时被调用')
  }

  const taskId = deps.scope.taskId
  const trackState = deps.origin.kind === 'agent' && deps.tasks !== undefined
  const stamp = (): string => deps.now?.() ?? new Date().toISOString()

  if (trackState) {
    deps.tasks?.updateStatus(taskId, 'waiting_permission', stamp())
  }

  try {
    return await gate.request({
      taskId,
      toolCallId: params.callId,
      capability: params.capability,
      bound
    })
  } finally {
    // 批准、拒绝、过期三种结论都要推回 running，所以放 finally。
    if (trackState) {
      try {
        deps.tasks?.updateStatus(taskId, 'running', stamp())
      } catch (e) {
        console.error(`[policy] 任务 ${taskId} 的状态推不回 running`, e)
      }
    }
  }
}
