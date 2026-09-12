import type { TaskRepository } from './task-repository'
import type { EventRepository } from './event-repository'
import type { PlanRepository } from './plan-repository'
import type { TaskTimeline } from '../../shared/domain'

// 形状的定义在 shared/domain.ts，这里 re-export，既有的 import 路径不用改。
export type { TaskTimeline }

export function projectTimeline(
  tasks: TaskRepository,
  events: EventRepository,
  plans: PlanRepository,
  taskId: string
): TaskTimeline | null {
  const task = tasks.findById(taskId)

  if (task === null) return null
  return {
    task,
    plan: plans.findLatest(taskId),
    events: events.listByTask(taskId)
  }
}
