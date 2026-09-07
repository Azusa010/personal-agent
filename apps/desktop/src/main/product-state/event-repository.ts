export interface ExecutionEventRecord {
  seq: number
  taskId: string
  type: string
  payload: unknown
  occurredAt: string
}

export type NewExecutionEvent = Omit<ExecutionEventRecord, 'seq'>

export interface EventRepository {
  append(event: NewExecutionEvent): number
  listByTask(taskId: string): ExecutionEventRecord[]
}
