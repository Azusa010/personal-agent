import type { SqliteDatabase } from './database'
import { TOOL_EXECUTION_STATUSES } from '../../shared/domain'
import type { ToolExecutionRecord, ToolExecutionStatus } from '../../shared/domain'

// 形状的定义在 shared/domain.ts，这里 re-export，与 task/permission repository 一致。
export { TOOL_EXECUTION_STATUSES }
export type { ToolExecutionRecord, ToolExecutionStatus }

export function isToolExecutionStatus(value: string): value is ToolExecutionStatus {
  return (TOOL_EXECUTION_STATUSES as readonly string[]).includes(value)
}

export const ALLOWED_TRANSITIONS: Record<ToolExecutionStatus, readonly ToolExecutionStatus[]> = {
  // TODO(你填): 给每个状态列出它能翻到的目标状态数组。空数组 = 该状态是终态，翻到哪都非法。
  attempting: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['attempting']
}

/** 已经落库的执行记录，又要翻到转换表不允许的状态。 */
export class IllegalToolExecutionTransition extends Error {
  constructor(
    readonly from: ToolExecutionStatus,
    readonly to: ToolExecutionStatus
  ) {
    super(`非法执行状态转换: ${from} → ${to}`)
    this.name = 'IllegalToolExecutionTransition'
  }
}

/** 校验一次状态翻转是否合法，非法就抛 IllegalToolExecutionTransition。*/
export function assertTransitionAllowed(from: ToolExecutionStatus, to: ToolExecutionStatus): void {
  if (!ALLOWED_TRANSITIONS[from]!.includes(to)) {
    throw new IllegalToolExecutionTransition(from, to)
  }
}

/** 数据库行的形状。列名与 0006 migration 的 DDL 逐字对应。 */
interface ToolExecutionRow {
  idempotency_key: string
  task_id: string
  tool_call_id: string
  capability: string
  args_hash: string
  source_paths: string
  target_path: string | null
  status: string
  attempted_at: string
  finished_at: string | null
  result_payload: string | null
}

function toRecord(row: ToolExecutionRow): ToolExecutionRecord {
  if (!isToolExecutionStatus(row.status)) {
    throw new Error(
      `tool_executions.status 出现 CHECK 未拦住的非法值: ${row.status} (key=${row.idempotency_key})`
    )
  }
  let sourcePaths: string[]
  try {
    sourcePaths = JSON.parse(row.source_paths) as string[]
  } catch {
    throw new Error(
      `tool_executions.source_paths 不是合法 JSON (key=${row.idempotency_key}): ${row.source_paths}`
    )
  }
  let resultPayload: unknown = null
  if (row.result_payload !== null) {
    try {
      resultPayload = JSON.parse(row.result_payload)
    } catch {
      throw new Error(
        `tool_executions.result_payload 不是合法 JSON (key=${row.idempotency_key}): ${row.result_payload}`
      )
    }
  }
  return {
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    capability: row.capability,
    argsHash: row.args_hash,
    sourcePaths,
    targetPath: row.target_path,
    status: row.status,
    attemptedAt: row.attempted_at,
    finishedAt: row.finished_at,
    resultPayload
  }
}

export interface ToolExecutionRepository {
  /** 执行前写入一条 attempting 记录。key 冲突由上层幂等关先查后决定，这里直接 INSERT */
  insert(record: ToolExecutionRecord): void
  /** 幂等关按 key 查当前状态。null = 这个副作用从没登记过 */
  findByKey(idempotencyKey: string): ToolExecutionRecord | null
  /** recovery 启动 pass 扫某个任务的全部执行记录，按 attempted_at 升序 */
  findByTaskId(taskId: string): ToolExecutionRecord[]
  /** 执行后翻转状态。先 findByKey 读当前状态经 assertTransitionAllowed 校验，再 UPDATE。
   *  toStatus='succeeded' 时把 resultPayload 序列化进 result_payload 列，命中已执行时原样返回 */
  transition(
    idempotencyKey: string,
    toStatus: ToolExecutionStatus,
    finishedAt: string,
    resultPayload?: unknown
  ): ToolExecutionRecord
}

const COLUMNS = `idempotency_key, task_id, tool_call_id, capability, args_hash,
  source_paths, target_path, status, attempted_at, finished_at, result_payload`

const INSERT_SQL = `
  INSERT INTO tool_executions (${COLUMNS})
  VALUES (@idempotencyKey, @taskId, @toolCallId, @capability, @argsHash,
          @sourcePaths, @targetPath, @status, @attemptedAt, @finishedAt, @resultPayload)
`
const SELECT_BY_KEY_SQL = `SELECT ${COLUMNS} FROM tool_executions WHERE idempotency_key = ?`
const SELECT_BY_TASK_ID_SQL = `SELECT ${COLUMNS} FROM tool_executions
  WHERE task_id = ? ORDER BY attempted_at ASC, idempotency_key ASC`
const TRANSITION_SQL = `UPDATE tool_executions
  SET status = @status, finished_at = @finishedAt, result_payload = @resultPayload
  WHERE idempotency_key = @idempotencyKey`

export class SqliteToolExecutionRepository implements ToolExecutionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: ToolExecutionRecord): void {
    this.db.prepare(INSERT_SQL).run({
      ...record,
      sourcePaths: JSON.stringify(record.sourcePaths),
      resultPayload: record.resultPayload === null ? null : JSON.stringify(record.resultPayload)
    })
  }

  findByKey(idempotencyKey: string): ToolExecutionRecord | null {
    const row = this.db.prepare(SELECT_BY_KEY_SQL).get(idempotencyKey) as
      ToolExecutionRow | undefined
    return row ? toRecord(row) : null
  }

  findByTaskId(taskId: string): ToolExecutionRecord[] {
    const rows = this.db.prepare(SELECT_BY_TASK_ID_SQL).all(taskId) as ToolExecutionRow[]
    return rows.map(toRecord)
  }

  transition(
    idempotencyKey: string,
    toStatus: ToolExecutionStatus,
    finishedAt: string,
    resultPayload?: unknown
  ): ToolExecutionRecord {
    const current = this.findByKey(idempotencyKey)
    if (current === null) {
      throw new Error(`tool_executions 中不存在 key=${idempotencyKey}`)
    }
    assertTransitionAllowed(current.status, toStatus)
    const payload = resultPayload === undefined ? null : resultPayload
    this.db.prepare(TRANSITION_SQL).run({
      idempotencyKey,
      status: toStatus,
      finishedAt,
      resultPayload: payload === null ? null : JSON.stringify(payload)
    })
    return { ...current, status: toStatus, finishedAt, resultPayload: payload }
  }
}
