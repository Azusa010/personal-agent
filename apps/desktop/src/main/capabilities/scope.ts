import { type CapabilityName, listByKind } from './registry'

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
 * 一次「整理 PDF」任务能用的能力：两个 READ 加三个 WRITE（TASK-028 起）。
 *
 * 手写而不是从 registry 过滤：这是一条权限边界，新增能力时应该有人显式决定它要不要
 * 进这个任务，而不是 filter 一放宽就自动放行。
 *
 * 顺序与 planning.PLAN_REQUIREMENTS 的能力项逐字一致（那边按它生成计划，这边按它
 * 放行）：少一项，计划里那一步就会撞 ACTION_NOT_ALIGNED；多一项，模型就会看见一个
 * 计划里永远用不到的工具。两份表的漂移由 e2e/golden-path.test.ts 的断言盯住。
 *
 * notification_send 不在内：它由 Reminder 到点触发（reminder-timer → fireReminder），
 * 不是模型能自选的动作。放进 Scope 等于让模型有权给任意一条提醒发通知。
 */
export const AGENT_TASK_CAPABILITIES: readonly CapabilityName[] = [
  'filesystem_list',
  'document_extract_pdf',
  'filesystem_create_dir',
  'filesystem_move',
  'scheduler_create'
]

export function agentTaskScope(taskId: string): TaskScope {
  return { taskId, capabilities: AGENT_TASK_CAPABILITIES }
}

export function isInScope(scope: TaskScope, name: string): boolean {
  return (scope.capabilities as readonly string[]).includes(name)
}
