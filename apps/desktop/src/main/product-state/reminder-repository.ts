import type { SqliteDatabase } from './database'
import { REMINDER_STATUSES } from '../../shared/domain'
import type { ReminderRecord, ReminderStatus } from '../../shared/domain'

// 形状的定义在 shared/domain.ts，这里 re-export，与 task/tool-execution repository 一致。
export { REMINDER_STATUSES }
export type { ReminderRecord, ReminderStatus }

export function isReminderStatus(value: string): value is ReminderStatus {
  return (REMINDER_STATUSES as readonly string[]).includes(value)
}

export const ALLOWED_TRANSITIONS: Record<ReminderStatus, readonly ReminderStatus[]> = {
  // scheduled → firing：到期开始触发（TASK-024 的 timer）。
  // firing → fired：通知发送成功，终态，永不再发。
  // firing → failed：通知失败，记下原因，只允许显式重试。
  // firing → scheduled：启动恢复（TASK-025）发现停在 firing 且没有 notification.sent，
  //   结果未知不敢算发过，重挂回待触发。
  // failed → firing：显式重试的唯一入口。
  scheduled: ['firing'],
  firing: ['fired', 'failed', 'scheduled'],
  fired: [],
  failed: ['firing']
}

/** 已经落库的 Reminder，又要翻到转换表不允许的状态。 */
export class IllegalReminderTransition extends Error {
  constructor(
    readonly from: ReminderStatus,
    readonly to: ReminderStatus
  ) {
    super(`非法 Reminder 状态转换: ${from} → ${to}`)
    this.name = 'IllegalReminderTransition'
  }
}

/** 同一 Task 已有 Reminder（task_id UNIQUE）。领域专用错误，
 *  executor 捕获后映射为 ERROR_CODE.REMINDER_ALREADY_EXISTS。 */
export class ReminderAlreadyExists extends Error {
  constructor(
    readonly taskId: string,
    readonly existingId: string
  ) {
    super(`任务 ${taskId} 已有 Reminder ${existingId}`)
    this.name = 'ReminderAlreadyExists'
  }
}

/** 校验一次状态翻转是否合法，非法就抛 IllegalReminderTransition。*/
export function assertTransitionAllowed(from: ReminderStatus, to: ReminderStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new IllegalReminderTransition(from, to)
  }
}

/** 数据库行的形状。列名与 0007 migration 的 DDL 逐字对应。 */
interface ReminderRow {
  id: string
  task_id: string
  tool_call_id: string
  remind_at: string
  message: string
  idempotency_key: string
  status: string
  created_at: string
  updated_at: string
  fired_at: string | null
  failure_reason: string | null
}

function toRecord(row: ReminderRow): ReminderRecord {
  if (!isReminderStatus(row.status)) {
    throw new Error(`reminders.status 出现 CHECK 未拦住的非法值: ${row.status} (id=${row.id})`)
  }
  return {
    id: row.id,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    remindAt: row.remind_at,
    message: row.message,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firedAt: row.fired_at,
    failureReason: row.failure_reason
  }
}

export interface ReminderRepository {
  /** 写入一条 scheduled 记录。该 Task 已有 Reminder 时抛 ReminderAlreadyExists，
   *  上层（executor）负责在调用前先查、决定幂等返回还是拒绝 */
  insert(reminder: ReminderRecord): void
  findById(id: string): ReminderRecord | null
  /** task_id UNIQUE，至多一条。null = 该任务还没有 Reminder */
  findByTaskId(taskId: string): ReminderRecord | null
  /** 状态翻转。先读当前状态经转换表校验，再 UPDATE。
   *  extra 里的字段给了才写（COALESCE 保留旧值）：翻 fired 传 firedAt，翻 failed 传 failureReason */
  transition(
    id: string,
    toStatus: ReminderStatus,
    updatedAt: string,
    extra?: { firedAt?: string; failureReason?: string }
  ): ReminderRecord
}

const COLUMNS = `id, task_id, tool_call_id, remind_at, message, idempotency_key,
  status, created_at, updated_at, fired_at, failure_reason`

const INSERT_SQL = `
  INSERT INTO reminders (${COLUMNS})
  VALUES (@id, @taskId, @toolCallId, @remindAt, @message, @idempotencyKey,
          @status, @createdAt, @updatedAt, @firedAt, @failureReason)
`
const SELECT_BY_ID_SQL = `SELECT ${COLUMNS} FROM reminders WHERE id = ?`
const SELECT_BY_TASK_ID_SQL = `SELECT ${COLUMNS} FROM reminders WHERE task_id = ?`
const TRANSITION_SQL = `UPDATE reminders
  SET status = @status, updated_at = @updatedAt,
      fired_at = COALESCE(@firedAt, fired_at),
      failure_reason = COALESCE(@failureReason, failure_reason)
  WHERE id = @id`

export class SqliteReminderRepository implements ReminderRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(reminder: ReminderRecord): void {
    const existing = this.findByTaskId(reminder.taskId)
    if (existing !== null) {
      throw new ReminderAlreadyExists(reminder.taskId, existing.id)
    }
    this.db.prepare(INSERT_SQL).run(reminder)
  }

  findById(id: string): ReminderRecord | null {
    const row = this.db.prepare(SELECT_BY_ID_SQL).get(id) as ReminderRow | undefined
    return row ? toRecord(row) : null
  }

  findByTaskId(taskId: string): ReminderRecord | null {
    const row = this.db.prepare(SELECT_BY_TASK_ID_SQL).get(taskId) as ReminderRow | undefined
    return row ? toRecord(row) : null
  }

  transition(
    id: string,
    toStatus: ReminderStatus,
    updatedAt: string,
    extra?: { firedAt?: string; failureReason?: string }
  ): ReminderRecord {
    const current = this.findById(id)
    if (current === null) {
      throw new Error(`reminders 中不存在 id=${id}`)
    }
    assertTransitionAllowed(current.status, toStatus)
    this.db.prepare(TRANSITION_SQL).run({
      id,
      status: toStatus,
      updatedAt,
      firedAt: extra?.firedAt ?? null,
      failureReason: extra?.failureReason ?? null
    })
    return {
      ...current,
      status: toStatus,
      updatedAt,
      firedAt: extra?.firedAt ?? current.firedAt,
      failureReason: extra?.failureReason ?? current.failureReason
    }
  }
}
