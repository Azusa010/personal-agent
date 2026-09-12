import type { SqliteDatabase } from './database'
import type { ExecutionEventRecord } from '../../shared/domain'

// 形状的定义在 shared/domain.ts，这里 re-export，既有的 import 路径不用改。
export type { ExecutionEventRecord }

export type NewExecutionEvent = Omit<ExecutionEventRecord, 'seq'>

export interface EventRepository {
  append(event: NewExecutionEvent): number
  listByTask(taskId: string): ExecutionEventRecord[]
}

// 数据库行
interface EventRow {
  seq: number
  task_id: string
  type: string
  payload: string
  occurred_at: string
}

function toEventRecord(row: EventRow): ExecutionEventRecord {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    throw new Error(
      `execution_events.payload 不是合法 JSON (seq=${row.seq}, task_id=${row.task_id}): ${row.payload}`
    )
  }
  return {
    seq: row.seq,
    taskId: row.task_id,
    type: row.type,
    payload: payload,
    occurredAt: row.occurred_at
  }
}

const APPEND_SQL = `
  INSERT INTO execution_events (task_id, type, payload, occurred_at)
  VALUES (@taskId, @type, @payload, @occurredAt)
`
const LIST_BY_TASK_SQL = `
  SELECT seq, task_id, type, payload, occurred_at
  FROM execution_events
  WHERE task_id = ?
  ORDER BY seq ASC
`

export class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: SqliteDatabase) {}
  append(event: NewExecutionEvent): number {
    const result = this.db.prepare(APPEND_SQL).run({
      taskId: event.taskId,
      type: event.type,
      payload: JSON.stringify(event.payload),
      occurredAt: event.occurredAt
    })
    return Number(result.lastInsertRowid)
  }
  listByTask(taskId: string): ExecutionEventRecord[] {
    const rows = this.db.prepare(LIST_BY_TASK_SQL).all(taskId) as EventRow[]
    return rows.map(toEventRecord)
  }
}
