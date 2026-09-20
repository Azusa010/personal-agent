import {
  DocumentExtractPdfParams,
  ERROR_CODE,
  FilesystemCreateDirParams,
  FilesystemListParams,
  FilesystemMoveParams,
  NotificationSendParams,
  SchedulerCreateParams,
  TerminalExecuteParams,
  type CapabilityId
} from '@personal-agent/protocol'

import { resolve } from 'node:path'

import { resolveWithinRootReal } from '../capabilities/path-guard'
import { resolveRoot, toPosix } from '../capabilities/roots'

/** 契约校验 + 路径规范化之后的一次调用参数。 */
export interface BoundArgs {
  /** 过了契约校验的参数，原样字段名。 */
  args: Record<string, unknown>
  /** 键与参数名一致，值是规范化后的绝对路径。 */
  paths: Record<string, string>
}

export type BindResult =
  { ok: true; bound: BoundArgs } | { ok: false; code: string; reason: string }

type Binder = (args: Record<string, unknown>) => Promise<BindResult>

function invalid(capability: string, message: string): BindResult {
  return {
    ok: false,
    code: ERROR_CODE.INVALID_ARGUMENT,
    reason: `${capability} 参数不符合契约: ${message}`
  }
}

// envelope 层的 arguments 是 z.record(z.string(), z.unknown())，什么都能过，
// 收窄只能在这里做。
const bindFilesystemList: Binder = async (args) => {
  const parsed = FilesystemListParams.safeParse(args)
  if (!parsed.success) return invalid('filesystem.list', parsed.error.message)
  // rootId 是白名单枚举里的一项，不是用户给的路径，所以不进 paths：
  // 授权根由 resolveRoot 从环境变量取，执行体自己会再取一次同一个值。
  return { ok: true, bound: { args: { rootId: parsed.data.rootId }, paths: {} } }
}

const bindExtractPdf: Binder = async (args) => {
  const parsed = DocumentExtractPdfParams.safeParse(args)
  if (!parsed.success) return invalid('document.extract_pdf', parsed.error.message)

  const root = resolveRoot('downloads')
  const guarded = await resolveWithinRootReal(root, parsed.data.path)
  if (!guarded.ok) {
    return { ok: false, code: guarded.code, reason: guarded.reason }
  }
  return {
    ok: true,
    bound: { args: { path: parsed.data.path }, paths: { path: guarded.path } }
  }
}

// 要建的目录几乎一定还不存在，所以这里依赖 resolveWithinRootReal 对
// 「不存在」的处理：它只对最近的存在祖先做 realpath，其余段原样拼回。
// 「已存在」也不在这拦——那要么由执行体幂等处理，要么就是一次无害的重建。
const bindCreateDir: Binder = async (args) => {
  const parsed = FilesystemCreateDirParams.safeParse(args)
  if (!parsed.success) return invalid('filesystem.create_dir', parsed.error.message)

  const root = resolveRoot('downloads')
  const guarded = await resolveWithinRootReal(root, parsed.data.path)
  if (!guarded.ok) {
    return { ok: false, code: guarded.code, reason: guarded.reason }
  }
  return {
    ok: true,
    bound: { args: { path: parsed.data.path }, paths: { path: guarded.path } }
  }
}

const bindMove: Binder = async (args) => {
  const parsed = FilesystemMoveParams.safeParse(args)
  if (!parsed.success) return invalid('filesystem.move', parsed.error.message)

  const root = resolveRoot('downloads')

  // 获得 source 的 realpath
  const source = await resolveWithinRootReal(root, parsed.data.source)
  if (!source.ok) {
    return {
      ok: false,
      code: source.code,
      reason: `${source.reason}（filesystem.move 的 source 参数）`
    }
  }

  // 获得 target 的 realpath
  const target = await resolveWithinRootReal(root, parsed.data.target)
  if (!target.ok) {
    return {
      ok: false,
      code: target.code,
      reason: `${target.reason}（filesystem.move 的 target 参数）`
    }
  }

  return {
    ok: true,
    bound: {
      args: { source: parsed.data.source, target: parsed.data.target },
      paths: { source: source.path, target: target.path }
    }
  }
}

// 创建定时提醒前参数检验
const bindSchedulerCreate: Binder = async (args) => {
  const parsed = SchedulerCreateParams.safeParse(args)
  if (!parsed.success) return invalid('scheduler.create', parsed.error.message)

  const remindAt = new Date(parsed.data.remindAt)
  if (Number.isNaN(remindAt.getTime())) {
    return {
      ok: false,
      code: ERROR_CODE.INVALID_ARGUMENT,
      reason: `scheduler.create 的 remindAt 无法解析为时间: ${parsed.data.remindAt}`
    }
  }
  const remindAtIso = remindAt.toISOString()
  // 过去的时刻直接拒：创建即过期的 Reminder 只会立刻触发一次「错过的提醒」，
  // 几乎必然是模型把相对时间解析错了，稳定错误码让它有机会改口。
  if (remindAt.getTime() <= Date.now()) {
    return {
      ok: false,
      code: ERROR_CODE.REMINDER_TIME_IN_PAST,
      reason: `提醒时间 ${remindAtIso} 不晚于当前时间，拒绝创建已到期的 Reminder`
    }
  }
  return {
    ok: true,
    bound: { args: { remindAt: remindAtIso, message: parsed.data.message }, paths: {} }
  }
}

// 发送通知前参数检验
const bindNotificationSend: Binder = async (args) => {
  const parsed = NotificationSendParams.safeParse(args)
  if (!parsed.success) return invalid('notification.send', parsed.error.message)
  return { ok: true, bound: { args: { reminderId: parsed.data.reminderId }, paths: {} } }
}

// 终端命令执行前参数校验与工作目录约束
const bindTerminalExecute: Binder = async (args) => {
  const parsed = TerminalExecuteParams.safeParse(args)
  if (!parsed.success) return invalid('terminal.execute', parsed.error.message)

  const root = resolveRoot('downloads')
  const paths: Record<string, string> = {}

  if (parsed.data.cwd !== undefined) {
    const targetCwd = resolve(root, parsed.data.cwd)
    const guarded = await resolveWithinRootReal(root, targetCwd)
    if (!guarded.ok) {
      return { ok: false, code: guarded.code, reason: guarded.reason }
    }
    paths['cwd'] = guarded.path
  } else {
    paths['cwd'] = toPosix(root)
  }

  return {
    ok: true,
    bound: {
      args: {
        command: parsed.data.command,
        ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
        ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {})
      },
      paths
    }
  }
}

/** 每个能力的参数绑定器。没有登记的能力回 NOT_IMPLEMENTED：
 */
const BINDERS: Partial<Record<CapabilityId, Binder>> = {
  'filesystem.list': bindFilesystemList,
  'document.extract_pdf': bindExtractPdf,
  'filesystem.create_dir': bindCreateDir,
  'filesystem.move': bindMove,
  'scheduler.create': bindSchedulerCreate,
  'notification.send': bindNotificationSend,
  'terminal.execute': bindTerminalExecute
}

export async function bindArguments(
  capability: string,
  args: Record<string, unknown>
): Promise<BindResult> {
  const binder = BINDERS[capability as CapabilityId]
  if (binder === undefined) {
    return { ok: false, code: ERROR_CODE.NOT_IMPLEMENTED, reason: `执行体未实现: ${capability}` }
  }
  return binder(args)
}
