export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TaskRecord {
  id: string
  goal: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export interface TaskRepository {
  insert(task: TaskRecord): void
  findById(id: string): TaskRecord | null
  findAll(): TaskRecord[]
  updateStatus(id: string, status: TaskStatus, updatedAt: string): void
}
