import type { TaskRecord, TaskRepository } from './task-repository'
import type { ExecutionEventRecord, EventRepository } from './event-repository'

export interface TaskTimeline {
  task: TaskRecord
  events: ExecutionEventRecord[]
}

export function projectTimeline(
  tasks: TaskRepository,
  events: EventRepository,
  taskId: string
): TaskTimeline | null {
  const task = tasks.findById(taskId)

  if (task === null) return null
  return {
    task,
    events: events.listByTask(taskId)
  }
}
