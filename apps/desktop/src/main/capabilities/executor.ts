import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'

import type { ReminderRecord } from '../../shared/domain'
import {
  createExecutionPolicy,
  type AuthorizedCall,
  type CallOrigin,
  type PermissionGate,
  type TaskStatePort
} from '../policy/execution-policy'
import type { NotificationPort } from '../notifications/notification-port'
import type { SqliteDatabase } from '../product-state/database'
import type { EventRepository } from '../product-state/event-repository'
import {
  ReminderAlreadyExists,
  type ReminderRepository
} from '../product-state/reminder-repository'
import type { ToolExecutionRepository } from '../product-state/tool-execution-repository'
import { extractPdf } from './document-extract-pdf'
import { createDir } from './filesystem-create-dir'
import { listPdfs } from './filesystem-list'
import { moveFile } from './filesystem-move'
import {
  afterExecute,
  beginAttempt,
  idempotencyKey,
  isWriteCapability,
  type IdempotencyDeps
} from './idempotency'
import { RuleBasedToolRetriever, type ToolRetriever } from './retriever'
import { resolveRoot } from './roots'
import type { TaskScope } from './scope'
import { fireReminder } from '../scheduler/fire-reminder'

export type CapabilityOutcome = Record<string, unknown>

/** Reminder 创建成功时与 insert 同事务落库的事件类型（PRD 4.9 reminder.created，
 *  仓库内命名跟随 permission_requested 的 snake_case 惯例）。 */
export const REMINDER_CREATED_EVENT = 'reminder_created'

/** 批准通道的集成。 */
export interface ExecutorPermissionWiring {
  readonly gate: PermissionGate
  readonly tasks?: TaskStatePort
  readonly now?: () => string
}

/** 幂等关的集成。不传就是没有幂等保护：WRITE 能力照常执行但不登记、不查重复。
 */
export interface ExecutorIdempotencyWiring {
  readonly executions: ToolExecutionRepository
  readonly now?: () => string
}

/** Reminder 存储的集成。不传时 scheduler_create 回 NOT_IMPLEMENTED——
 *  宁可明说没接线，也不半创建状态。db 只用来把 insert 与事件包进同一事务
 *  - notifications：notification_send 的通知端口，不传时该能力回 NOT_IMPLEMENTED；
 *  - armTimer：scheduler_create 新建成功后挂触发定时器的钩子
 */
export interface ExecutorSchedulerWiring {
  readonly db: SqliteDatabase
  readonly reminders: ReminderRepository
  readonly events: EventRepository
  readonly now?: () => string
  readonly newId?: () => string
  readonly notifications?: NotificationPort
  readonly armTimer?: (reminder: ReminderRecord) => void
}

export function createExecutor(
  scope: TaskScope,
  origin: CallOrigin,
  retriever: ToolRetriever = new RuleBasedToolRetriever(),
  permission?: ExecutorPermissionWiring,
  idempotency?: ExecutorIdempotencyWiring,
  scheduler?: ExecutorSchedulerWiring
): (params: HostExecuteToolParams) => Promise<CapabilityOutcome> {
  const policy = createExecutionPolicy({
    scope,
    retriever,
    origin,
    permissions: permission?.gate,
    tasks: permission?.tasks,
    now: permission?.now
  })
  return async (params) => {
    const decision = await policy.evaluate(params)
    if (!decision.allowed) {
      return fail(decision.code, decision.reason)
    }
    const call = decision.call
    // 没接幂等 store，或不是 WRITE 能力（只读无副作用）→ 直接执行，维持原行为。
    // scheduler_create 虽是 WRITE 但不进这道关：它的副作用是库内一行而不是
    // 文件系统，reminders.task_id UNIQUE + 执行体内按 idempotencyKey 比对已经
    // 覆盖了「同参重试幂等返回、异参拒绝」，没有需要 recovery resolver 复查的中间态。
    if (idempotency === undefined || !isWriteCapability(call.capability.name)) {
      return runCapability(call, scheduler)
    }
    // WRITE 能力过幂等关：执行前查重复决定跑不跑，执行后把 attempting 翻成终态。
    const deps: IdempotencyDeps = { executions: idempotency.executions, now: idempotency.now }
    const before = await beginAttempt(deps, call)
    if (before.kind !== 'proceed') {
      // skip（已成功）或 reject（矛盾态）都直接返回结果，不跑副作用。
      return before.result
    }
    const outcome = await runCapability(call, scheduler)
    afterExecute(deps, before.key, outcome)
    return outcome
  }
}

function fail(code: string, reason: string): CapabilityOutcome {
  return { ok: false, code, reason }
}

// 策略已经把注册、Scope、对齐、风险、契约、路径全判完了，这里只做副作用。
// 所以分支的依据是 descriptor.name（registry 里的真名），不是模型给的字符串。
async function runCapability(
  call: AuthorizedCall,
  scheduler?: ExecutorSchedulerWiring
): Promise<CapabilityOutcome> {
  switch (call.capability.name) {
    case 'filesystem_list':
      return runFilesystemList(call)
    case 'document_extract_pdf':
      return runExtractPdf(call)
    case 'filesystem_create_dir':
      return runCreateDir(call)
    case 'filesystem_move':
      return runMove(call)
    case 'scheduler_create':
      return runSchedulerCreate(call, scheduler)
    case 'notification_send':
      return runNotificationSend(call, scheduler)
    case 'terminal_execute':
      return runTerminalExecute(call)
    default:
      // BINDERS 与这个 switch 是两张必须同步的表。加了 binder 忘了执行体，
      // 会走到这里而不是崩掉——这是故意留的兜底。
      return fail(ERROR_CODE.NOT_IMPLEMENTED, `执行体未实现: ${call.capability.name}`)
  }
}

async function runFilesystemList(call: AuthorizedCall): Promise<CapabilityOutcome> {
  // 不再 safeParse：argument-binders 已经用 FilesystemListParams 校验过。
  // 这里再 parse 一次就等于承认「校验过的东西还能变」。
  const rootId = String(call.bound.args['rootId'])
  try {
    const entries = await listPdfs(resolveRoot(rootId))
    return { ok: true, entries }
  } catch (e) {
    return fail(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE, `授权根不可用 (${describe(e)})`)
  }
}

async function runExtractPdf(call: AuthorizedCall): Promise<CapabilityOutcome> {
  // bound.paths['path'] 是 realpath 之后的真实绝对路径，直接喂 readFile。
  // 用原始 path 的话，日志里的路径与实际读的可能不是同一个文件。
  const abs = call.bound.paths['path']
  let raw: Buffer
  try {
    raw = await readFile(abs)
  } catch (e) {
    return fail(ERROR_CODE.FILE_UNREADABLE, `读取失败 (${describe(e)}): ${abs}`)
  }
  try {
    return await extractPdf(raw)
  } catch (e) {
    return fail(ERROR_CODE.PDF_EXTRACTION_FAILED, `PDF 解析失败 (${describe(e)})`)
  }
}

async function runCreateDir(call: AuthorizedCall): Promise<CapabilityOutcome> {
  const abs = call.bound.paths['path']
  try {
    return await createDir(abs)
  } catch (e) {
    // createDir 契约上永不 throw；这里兜底是防实现意外抛，把精确码留住。
    return fail(ERROR_CODE.CREATE_DIR_FAILED, `创建目录失败 (${describe(e)}): ${abs}`)
  }
}

async function runMove(call: AuthorizedCall): Promise<CapabilityOutcome> {
  // source/target 同样是 realpath 后的绝对路径，与批准时算 hash 的那份一致。
  const source = call.bound.paths['source']
  const target = call.bound.paths['target']
  try {
    return await moveFile(source, target)
  } catch (e) {
    return fail(ERROR_CODE.MOVE_FAILED, `移动失败 (${describe(e)}): ${source} -> ${target}`)
  }
}

/** scheduler_create：在 reminders 表落一条 scheduled 记录，与 reminder_created
 *  事件同事务提交。
 *
 *  「同一 Task 不创建重复 Reminder」的判定顺序：
 *  1. 该任务已有 Reminder 且 idempotencyKey 相同 → 同参重试，幂等返回已有记录
 *    （created:false），绝不落第二条——崩溃后 Python 重发同一次调用走的就是这条路；
 *  2. 已有但 key 不同 → 参数变了（新时间/新文案），拒绝并回稳定错误码。
 *    静默用旧记录冒充成功，等于对用户刚批准的新时间撒谎。
 */
function runSchedulerCreate(
  call: AuthorizedCall,
  scheduler: ExecutorSchedulerWiring | undefined
): CapabilityOutcome {
  if (scheduler === undefined) {
    return fail(ERROR_CODE.NOT_IMPLEMENTED, 'scheduler_create 没有接线 Reminder 存储')
  }
  // binder 已把 remindAt 规范化成 UTC ISO、message 校验过非空，这里直接用。
  const remindAt = String(call.bound.args['remindAt'])
  const message = String(call.bound.args['message'])
  const key = idempotencyKey(call.taskId, call.capability.name, call.bound)

  const existing = scheduler.reminders.findByTaskId(call.taskId)
  if (existing !== null) {
    if (existing.idempotencyKey === key) {
      return {
        ok: true,
        reminderId: existing.id,
        remindAt: existing.remindAt,
        status: existing.status,
        created: false
      }
    }
    return fail(
      ERROR_CODE.REMINDER_ALREADY_EXISTS,
      `任务 ${call.taskId} 已有 Reminder ${existing.id}（${existing.remindAt}），拒绝再建第二个`
    )
  }

  const stamp = scheduler.now?.() ?? new Date().toISOString()
  const record: ReminderRecord = {
    id: scheduler.newId?.() ?? randomUUID(),
    taskId: call.taskId,
    toolCallId: call.callId,
    remindAt,
    message,
    idempotencyKey: key,
    status: 'scheduled',
    createdAt: stamp,
    updatedAt: stamp,
    firedAt: null,
    failureReason: null
  }
  try {
    const commit = scheduler.db.transaction(() => {
      scheduler.reminders.insert(record)
      scheduler.events.append({
        taskId: call.taskId,
        type: REMINDER_CREATED_EVENT,
        payload: {
          reminderId: record.id,
          toolCallId: record.toolCallId,
          remindAt: record.remindAt,
          message: record.message,
          idempotencyKey: record.idempotencyKey
        },
        occurredAt: stamp
      })
    })
    commit()
  } catch (e) {
    if (e instanceof ReminderAlreadyExists) {
      return fail(ERROR_CODE.REMINDER_ALREADY_EXISTS, e.message)
    }
    return fail(ERROR_CODE.SCHEDULER_CREATE_FAILED, `Reminder 落库失败 (${describe(e)})`)
  }
  try {
    scheduler.armTimer?.(record)
  } catch (e) {
    console.error(`[executor] Reminder ${record.id} 挂表失败，等启动恢复兜底`, e)
  }
  return { ok: true, reminderId: record.id, remindAt, status: 'scheduled', created: true }
}

/**
 * 执行通知发送
 * @param call : AuthorizedCall
 * @param scheduler : ExecutorSchedulerWiring | undefined
 * @returns
 */
async function runNotificationSend(
  call: AuthorizedCall,
  scheduler: ExecutorSchedulerWiring | undefined
): Promise<CapabilityOutcome> {
  if (scheduler?.notifications === undefined) {
    return fail(ERROR_CODE.NOT_IMPLEMENTED, 'notification_send 没有接线通知端口')
  }
  // binder 已校验 reminderId 非空，这里直接用。
  const reminderId = String(call.bound.args['reminderId'])
  const reminder = scheduler.reminders.findById(reminderId)
  if (reminder === null) {
    return fail(ERROR_CODE.REMINDER_NOT_FOUND, `Reminder 不存在: ${reminderId}`)
  }
  if (reminder.taskId !== call.taskId) {
    return fail(ERROR_CODE.REMINDER_NOT_FOUND, `Reminder 不存在: ${reminderId}`)
  }
  const outcome = await fireReminder(reminder, {
    db: scheduler.db,
    reminders: scheduler.reminders,
    events: scheduler.events,
    notifications: scheduler.notifications,
    now: scheduler.now
  })
  switch (outcome.kind) {
    case 'sent':
      return { ok: true, reminderId, status: 'fired', sentAt: outcome.sentAt, sent: true }
    case 'already_sent':
      return { ok: true, reminderId, status: 'fired', sentAt: outcome.sentAt, sent: false }
    case 'send_failed':
      return fail(ERROR_CODE.NOTIFICATION_SEND_FAILED, outcome.reason)
    case 'rejected':
      return fail(outcome.code, outcome.reason)
  }
}

/**
 * 执行终端命令行并捕获结果
 */
async function runTerminalExecute(call: AuthorizedCall): Promise<CapabilityOutcome> {
  const command = String(call.bound.args['command'])
  const cwd = call.bound.paths['cwd'] ?? resolveRoot('downloads')
  const timeoutMs =
    typeof call.bound.args['timeoutMs'] === 'number' ? call.bound.args['timeoutMs'] : 30_000

  return new Promise<CapabilityOutcome>((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const outStr = String(stdout ?? '')
        const errStr = String(stderr ?? '')

        if (error) {
          if (error.killed || error.signal === 'SIGTERM') {
            resolve(fail(ERROR_CODE.TERMINAL_TIMEOUT, `命令执行超时 (${timeoutMs}ms)`))
            return
          }
          if (typeof error.code === 'number') {
            resolve({
              ok: true,
              exitCode: error.code,
              stdout: outStr,
              stderr: errStr
            })
            return
          }
          resolve(fail(ERROR_CODE.TERMINAL_EXECUTE_FAILED, `命令执行异常: ${describe(error)}`))
          return
        }

        resolve({
          ok: true,
          exitCode: 0,
          stdout: outStr,
          stderr: errStr
        })
      }
    )
  })
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code ? `${code}: ${e.message}` : e.message
  }
  return String(e)
}
