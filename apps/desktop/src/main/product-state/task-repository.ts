import type { SqliteDatabase } from './database'
import { TASK_STATUSES } from '../../shared/domain'
import type { TaskRecord, TaskStatus } from '../../shared/domain'

// 形状的定义在 shared/domain.ts，这里 re-export，既有的 import 路径不用改。
export { TASK_STATUSES }
export type { TaskRecord, TaskStatus }

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value)
}

export const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['running'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
}

export class IllegalTaskTransition extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus
  ) {
    super(`非法状态转换: ${from} → ${to}`)
    this.name = 'IllegalTaskTransition'
  }
}

export function assertTransitionAllowed(from: TaskStatus, to: TaskStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new IllegalTaskTransition(from, to)
  }
}

/** 数据库行的形状 */
interface TaskRow {
  id: string
  goal: string
  status: string
  created_at: string
  updated_at: string
}

function toRecord(row: TaskRow): TaskRecord {
  if (!isTaskStatus(row.status)) {
    throw new Error(`tasks.status 出现 CHECK 未拦住的非法值: ${row.status} (id=${row.id})`)
  }
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface TaskRepository {
  insert(task: TaskRecord): void
  findById(id: string): TaskRecord | null
  findAll(): TaskRecord[]
  updateStatus(id: string, status: TaskStatus, updatedAt: string): void
}

const INSERT_SQL = `
  INSERT INTO tasks (id, goal, status, created_at, updated_at)
  VALUES (@id, @goal, @status, @createdAt, @updatedAt)
`
const SELECT_BY_ID_SQL = `
  SELECT id, goal, status, created_at, updated_at FROM tasks WHERE id = ?
`
const SELECT_ALL_SQL = `
  SELECT id, goal, status, created_at, updated_at FROM tasks ORDER BY created_at ASC, id ASC
`
const UPDATE_STATUS_SQL = `
  UPDATE tasks SET status = @status, updated_at = @updatedAt WHERE id = @id
`

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: SqliteDatabase) {}
  insert(task: TaskRecord): void {
    this.db.prepare(INSERT_SQL).run(task)
  }
  findById(id: string): TaskRecord | null {
    const row = this.db.prepare(SELECT_BY_ID_SQL).get(id) as TaskRow | undefined
    return row ? toRecord(row) : null
  }
  findAll(): TaskRecord[] {
    const row = this.db.prepare(SELECT_ALL_SQL).all() as TaskRow[]
    return row.map(toRecord)
  }
  updateStatus(id: string, status: TaskStatus, updatedAt: string): void {
    const current = this.findById(id)
    if (current === null) {
      throw new Error(`tasks 中不存在 id=${id}`)
    }
    assertTransitionAllowed(current.status, status)
    this.db.prepare(UPDATE_STATUS_SQL).run({ id, status, updatedAt })
  }
}
