export const TASK_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 领域对象 */
export interface TaskRecord {
  id: string
  goal: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

/** 一条执行事件。payload 是 unknown：六种事件类型各有各的形状，窄化是读方的事 */
export interface ExecutionEventRecord {
  seq: number
  taskId: string
  type: string
  payload: unknown
  occurredAt: string
}

/** 一个任务的完整投影：任务本体 + 按 seq 升序的事件 */
export interface TaskTimeline {
  task: TaskRecord
  events: ExecutionEventRecord[]
}
