import type { PlanStep } from '../../shared/domain'

/**
 * 一个正在跑的任务在策略眼里的样子。
 */
export interface ActiveTask {
  readonly taskId: string
  readonly goal: string
  readonly plan: readonly PlanStep[]
  executedCalls: number
}

/**
 * 已经有一个任务在跑，又来一个 beginTask。
 */
export class TaskBusyError extends Error {
  constructor(readonly runningTaskId: string) {
    super(`已有任务在跑: ${runningTaskId}`)
    this.name = 'TaskBusyError'
  }
}

// 当前正在跑的任务
let current: ActiveTask | null = null

export function beginTask(taskId: string, goal: string, plan: readonly PlanStep[]): ActiveTask {
  if (current !== null) {
    throw new TaskBusyError(current.taskId)
  }
  current = { taskId, goal, plan, executedCalls: 0 }
  return current
}

/** 幂等：run-task.ts 在 finally 里调，重复调或在没有任务时调都不能抛。
 *  抛了就会盖掉真正的失败原因。
 */
export function endTask(): void {
  current = null
}

export function currentTask(): ActiveTask | null {
  return current
}

/** 放行一次工具调用后由策略自己加一，返回加完之后的序号（第几次，从 1 起）。 */
export function recordExecutedCall(): number {
  if (current === null) return 0
  current.executedCalls += 1
  return current.executedCalls
}
