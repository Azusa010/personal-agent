import { SqliteDatabase } from './database'

export interface PlanStep {
  description: string
  capability?: string
}

export interface PlanRecord {
  id: string
  taskId: string
  version: number
  steps: PlanStep[]
  createdAt: string
}

export type NewPlan = Omit<PlanRecord, 'version'>

export interface PlanRepository {
  /** 追加一个新版本，version 自动 = 该 task 当前最大版本 + 1 */
  append(plan: NewPlan): PlanRecord
  /** 最新版本；该 task 没有 plan 时返回 null */
  findLatest(taskId: string): PlanRecord | null
  /** 全部版本，按 version 升序 */
  findAllVersions(taskId: string): PlanRecord[]
}

interface PlanRow {
  id: string
  task_id: string
  version: number
  steps: string
  created_at: string
}

function toPlanRecord(row: PlanRow): PlanRecord {
  let steps: PlanStep[]
  try {
    steps = JSON.parse(row.steps) as PlanStep[]
  } catch {
    throw new Error(
      `plans.steps 不是合法 JSON (task_id=${row.task_id}, version=${row.version}): ${row.steps}`
    )
  }
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    steps,
    createdAt: row.created_at
  }
}

const NEXT_VERSION_SQL = `
  SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plans WHERE task_id = ?
`
const APPEND_SQL = `
  INSERT INTO plans (id, task_id, version, steps, created_at)
  VALUES (@id, @taskId, @version, @steps, @createdAt)
`
const SELECT_LATEST_SQL = `
  SELECT id, task_id, version, steps, created_at
  FROM plans WHERE task_id = ? ORDER BY version DESC LIMIT 1
`
const SELECT_ALL_VERSIONS_SQL = `
  SELECT id, task_id, version, steps, created_at
  FROM plans WHERE task_id = ? ORDER BY version ASC
`
export class SqlitePlanRepository implements PlanRepository {
  constructor(private readonly db: SqliteDatabase) {}

  append(plan: NewPlan): PlanRecord {
    const row = this.db.prepare(NEXT_VERSION_SQL).get(plan.taskId) as { next: number }
    const version = row.next

    this.db.prepare(APPEND_SQL).run({
      id: plan.id,
      taskId: plan.taskId,
      version,
      steps: JSON.stringify(plan.steps),
      createdAt: plan.createdAt
    })
    return { ...plan, version }
  }

  findLatest(taskId: string): PlanRecord | null {
    const row = this.db.prepare(SELECT_LATEST_SQL).get(taskId) as PlanRow | null
    return row ? toPlanRecord(row) : null
  }

  findAllVersions(taskId: string): PlanRecord[] {
    const rows = this.db.prepare(SELECT_ALL_VERSIONS_SQL).all(taskId) as PlanRow[]
    return rows?.map(toPlanRecord)
  }
}
