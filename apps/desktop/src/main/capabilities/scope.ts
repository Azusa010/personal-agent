import { type CapabilityName, listByKind, listCapabilities } from './registry'

export interface TaskScope {
  taskId: string
  capabilities: readonly CapabilityName[]
}

export function readOnlyScope(taskId: string): TaskScope {
  return {
    taskId,
    capabilities: listByKind('READ').map((c) => c.name)
  }
}

/**
 * 完整 Agent 任务可用能力集：排除内部专用触发工具 notification_send。
 * 动态从 registry / plugins 获取，确保新增能力插件自动暴露给 Agent，无需手动维护白名单。
 */
export const AGENT_TASK_CAPABILITIES: readonly CapabilityName[] = listCapabilities()
  .map((c) => c.name as CapabilityName)
  .filter((name) => name !== 'notification_send')

export function agentTaskScope(taskId: string): TaskScope {
  return { taskId, capabilities: AGENT_TASK_CAPABILITIES }
}

/**
 * 基于基础任务能力扩展额外授权能力（如知识库检索、维基读写等）。
 */
export function extendedScope(
  taskId: string,
  extraCapabilities: readonly CapabilityName[]
): TaskScope {
  return {
    taskId,
    capabilities: Array.from(new Set([...AGENT_TASK_CAPABILITIES, ...extraCapabilities]))
  }
}

/**
 * 从计划动态推导任务所需的 Scope。
 * 至少包含 Agent 基础可用能力以及计划步骤中显式要求的任何能力。
 */
export function deriveScopeFromPlan(
  taskId: string,
  plan?: readonly { capability?: string | null; description?: string; [key: string]: unknown }[],
  baseCapabilities: readonly CapabilityName[] = AGENT_TASK_CAPABILITIES
): TaskScope {
  if (!plan || plan.length === 0) {
    return { taskId, capabilities: baseCapabilities }
  }
  const planCaps = plan
    .map((step) => step.capability)
    .filter((cap): cap is CapabilityName => typeof cap === 'string' && cap.length > 0)
  return {
    taskId,
    capabilities: Array.from(new Set([...baseCapabilities, ...planCaps]))
  }
}

export function isInScope(scope: TaskScope, name: string): boolean {
  return (scope.capabilities as readonly string[]).includes(name)
}
