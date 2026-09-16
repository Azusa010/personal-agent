import type { SqliteDatabase } from './database'
import { PERMISSION_DECISIONS } from '../../shared/domain'
import type { PermissionDecision, PermissionRecord, PermissionStatus } from '../../shared/domain'

export { PERMISSION_DECISIONS }
export type { PermissionDecision, PermissionRecord, PermissionStatus }

export function isPermissionStatus(value: string): value is PermissionStatus {
  return value === 'pending' || (PERMISSION_DECISIONS as readonly string[]).includes(value)
}

// 权限已经决定过，而且这次的结论与上次不同。
export class PermissionAlreadyDecided extends Error {
  constructor(
    readonly permissionId: string,
    readonly existing: PermissionDecision,
    readonly attempted: PermissionDecision
  ) {
    super(`Permission ${permissionId} 已经是 ${existing}，不能再改成 ${attempted}`)
    this.name = 'PermissionAlreadyDecided'
  }
}

export interface PermissionRepository {
  insert(permission: PermissionRecord): void
  findById(id: string): PermissionRecord | null
  /** (task_id, tool_call_id) 上有 UNIQUE 约束，最多一条。
   *  tool_call_id 只在任务内有意义（模型每次都从 call-1 数起），所以查询也必须
   *  带 taskId——只按 callId 查会命中别的任务那条权限。 */
  findByTaskAndToolCall(taskId: string, toolCallId: string): PermissionRecord | null
  /** 该任务的全部 Permission，按 requested_at 升序 */
  findByTaskId(taskId: string): PermissionRecord[]
  /** 写结论。同一结论重复调用幂等返回，不同结论抛 PermissionAlreadyDecided */
  decide(id: string, decision: PermissionDecision, decidedAt: string): PermissionRecord
}

/** 数据库行的形状 */
interface PermissionRow {
  id: string
  task_id: string
  tool_call_id: string
  capability: string
  args_canonical: string
  args_hash: string
  status: string
  requested_at: string
  expires_at: string
  decided_at: string | null
  source_paths: string
  target_path: string | null
}

const COLUMNS = `id, task_id, tool_call_id, capability, args_canonical, args_hash,
  status, requested_at, expires_at, decided_at, source_paths, target_path`

// 行转记录
function toRecord(row: PermissionRow): PermissionRecord {
  if (!isPermissionStatus(row.status)) {
    throw new Error(`permissions.status 出现 CHECK 未拦住的非法值: ${row.status} (id=${row.id})`)
  }
  let sourcePaths: string[]
  try {
    sourcePaths = JSON.parse(row.source_paths) as string[]
  } catch {
    throw new Error(`permissions.source_paths 不是合法 JSON (id=${row.id}): ${row.source_paths}`)
  }
  return {
    id: row.id,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    capability: row.capability,
    argsCanonical: row.args_canonical,
    argsHash: row.args_hash,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    sourcePaths,
    targetPath: row.target_path
  }
}

const INSERT_SQL = `
  INSERT INTO permissions (${COLUMNS})
  VALUES (@id, @taskId, @toolCallId, @capability, @argsCanonical, @argsHash,
          @status, @requestedAt, @expiresAt, @decidedAt, @sourcePaths, @targetPath)
`
const SELECT_BY_ID_SQL = `SELECT ${COLUMNS} FROM permissions WHERE id = ?`
const SELECT_BY_TASK_AND_TOOL_CALL_SQL = `SELECT ${COLUMNS} FROM permissions
  WHERE task_id = ? AND tool_call_id = ?`
const SELECT_BY_TASK_ID_SQL = `SELECT ${COLUMNS} FROM permissions
  WHERE task_id = ? ORDER BY requested_at ASC, id ASC`
const DECIDE_SQL = `UPDATE permissions SET status = @status, decided_at = @decidedAt WHERE id = @id`

export class SqlitePermissionRepository implements PermissionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(permission: PermissionRecord): void {
    this.db
      .prepare(INSERT_SQL)
      .run({ ...permission, sourcePaths: JSON.stringify(permission.sourcePaths) })
  }

  findById(id: string): PermissionRecord | null {
    const row = this.db.prepare(SELECT_BY_ID_SQL).get(id) as PermissionRow | undefined
    return row ? toRecord(row) : null
  }

  findByTaskAndToolCall(taskId: string, toolCallId: string): PermissionRecord | null {
    const row = this.db.prepare(SELECT_BY_TASK_AND_TOOL_CALL_SQL).get(taskId, toolCallId) as
      PermissionRow | undefined
    return row ? toRecord(row) : null
  }

  findByTaskId(taskId: string): PermissionRecord[] {
    const rows = this.db.prepare(SELECT_BY_TASK_ID_SQL).all(taskId) as PermissionRow[]
    return rows.map(toRecord)
  }

  decide(id: string, decision: PermissionDecision, decidedAt: string): PermissionRecord {
    const current = this.findById(id)
    if (current === null) {
      throw new Error(`permissions 中不存在 id=${id}`)
    }
    if (current.status !== 'pending') {
      if (current.status === decision) {
        return current
      }
      throw new PermissionAlreadyDecided(id, current.status, decision)
    }
    this.db.prepare(DECIDE_SQL).run({ id, status: decision, decidedAt })
    return { ...current, status: decision, decidedAt }
  }
}
