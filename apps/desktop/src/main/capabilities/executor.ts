import { readFile } from 'node:fs/promises'

import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'

import {
  createExecutionPolicy,
  type AuthorizedCall,
  type CallOrigin
} from '../policy/execution-policy'
import { extractPdf } from './document-extract-pdf'
import { listPdfs } from './filesystem-list'
import { RuleBasedToolRetriever, type ToolRetriever } from './retriever'
import { resolveRoot } from './roots'
import type { TaskScope } from './scope'

export type CapabilityOutcome = Record<string, unknown>

/** origin 不给默认值：它是安全参数，漏传等于静默降级成弱策略，
 *  而这正是 Phase 2 要防的「绕过」。TS 逼每个调用点当场决定。
 */
export function createExecutor(
  scope: TaskScope,
  origin: CallOrigin,
  retriever: ToolRetriever = new RuleBasedToolRetriever()
): (params: HostExecuteToolParams) => Promise<CapabilityOutcome> {
  const policy = createExecutionPolicy({ scope, retriever, origin })
  return async (params) => {
    const decision = await policy.evaluate(params)
    if (!decision.allowed) {
      return fail(decision.code, decision.reason)
    }
    return runCapability(decision.call)
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

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code ? `${code}: ${e.message}` : e.message
  }
  return String(e)
}
