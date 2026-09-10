import { readFile } from 'node:fs/promises'

import {
  DocumentExtractPdfParams,
  ERROR_CODE,
  FilesystemListParams,
  type HostExecuteToolParams
} from '@personal-agent/protocol'

import { extractPdf } from './document-extract-pdf'
import { listPdfs } from './filesystem-list'
import { resolveWithinRoot } from './path-guard'
import { RuleBasedToolRetriever, type ToolRetriever } from './retriever'
import { resolveRoot } from './roots'
import type { TaskScope } from './scope'
export type CapabilityOutcome = Record<string, unknown>

export function createExecutor(
  scope: TaskScope,
  retriever: ToolRetriever = new RuleBasedToolRetriever()
): (params: HostExecuteToolParams) => Promise<CapabilityOutcome> {
  return async (params) => {
    const auth = retriever.authorize(scope, params.capability)
    if (!auth.allowed) {
      return fail(auth.code, auth.reason)
    }

    switch (params.capability) {
      case 'filesystem.list':
        return runFilesystemList(params.arguments)
      case 'document.extract_pdf':
        return runExtractPdf(params.arguments)
      default:
        return fail(ERROR_CODE.NOT_IMPLEMENTED, `执行体未实现: ${params.capability}`)
    }
  }
}
function fail(code: string, reason: string): CapabilityOutcome {
  return { ok: false, code, reason }
}

async function runFilesystemList(arg: unknown): Promise<CapabilityOutcome> {
  const parsed = FilesystemListParams.safeParse(arg)
  if (!parsed.success) {
    return fail(
      ERROR_CODE.INVALID_ARGUMENT,
      `filesystem.list 参数不符合契约: ${parsed.error.message}`
    )
  }
  try {
    const entries = await listPdfs(resolveRoot(parsed.data.rootId))
    return { ok: true, entries }
  } catch (e) {
    return fail(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE, `授权根不可用 (${describe(e)})`)
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code ? `${code}: ${e.message}` : e.message
  }
  return String(e)
}

async function runExtractPdf(arg: unknown): Promise<CapabilityOutcome> {
  const parsed = DocumentExtractPdfParams.safeParse(arg)
  if (!parsed.success) {
    return fail(
      ERROR_CODE.INVALID_ARGUMENT,
      `document.extract_pdf 参数不符合契约: ${parsed.error.message}`
    )
  }
  const root = resolveRoot('downloads')
  const abs = resolveWithinRoot(root, parsed.data.path)
  if (abs === null) {
    return fail(ERROR_CODE.PATH_OUT_OF_ROOT, `路径不在授权根 ${root} 内: ${parsed.data.path}`)
  }

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
