import { readFile } from 'node:fs/promises'

import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'

import {
  createExecutionPolicy,
  type AuthorizedCall,
  type CallOrigin,
  type PermissionGate,
  type TaskStatePort
} from '../policy/execution-policy'
import type { ToolExecutionRepository } from '../product-state/tool-execution-repository'
import { extractPdf } from './document-extract-pdf'
import { createDir } from './filesystem-create-dir'
import { listPdfs } from './filesystem-list'
import { moveFile } from './filesystem-move'
import { afterExecute, beginAttempt, isWriteCapability, type IdempotencyDeps } from './idempotency'
import { RuleBasedToolRetriever, type ToolRetriever } from './retriever'
import { resolveRoot } from './roots'
import type { TaskScope } from './scope'

export type CapabilityOutcome = Record<string, unknown>

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

export function createExecutor(
  scope: TaskScope,
  origin: CallOrigin,
  retriever: ToolRetriever = new RuleBasedToolRetriever(),
  permission?: ExecutorPermissionWiring,
  idempotency?: ExecutorIdempotencyWiring
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
    if (idempotency === undefined || !isWriteCapability(call.capability.name)) {
      return runCapability(call)
    }
    // WRITE 能力过幂等关：执行前查重复决定跑不跑，执行后把 attempting 翻成终态。
    const deps: IdempotencyDeps = { executions: idempotency.executions, now: idempotency.now }
    const before = await beginAttempt(deps, call)
    if (before.kind !== 'proceed') {
      // skip（已成功）或 reject（矛盾态）都直接返回结果，不跑副作用。
      return before.result
    }
    const outcome = await runCapability(call)
    afterExecute(deps, before.key, outcome)
    return outcome
  }
}

function fail(code: string, reason: string): CapabilityOutcome {
  return { ok: false, code, reason }
}

// 策略已经把注册、Scope、对齐、风险、契约、路径全判完了，这里只做副作用。
// 所以分支的依据是 descriptor.name（registry 里的真名），不是模型给的字符串。
async function runCapability(call: AuthorizedCall): Promise<CapabilityOutcome> {
  switch (call.capability.name) {
    case 'filesystem.list':
      return runFilesystemList(call)
    case 'document.extract_pdf':
      return runExtractPdf(call)
    case 'filesystem.create_dir':
      return runCreateDir(call)
    case 'filesystem.move':
      return runMove(call)
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

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code ? `${code}: ${e.message}` : e.message
  }
  return String(e)
}
