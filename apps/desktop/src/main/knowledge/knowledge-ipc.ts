import {
  KnowledgeImportParams,
  KnowledgeImportResult,
  KnowledgeListResult,
  KnowledgeMode,
  KnowledgeSearchParams,
  KnowledgeSearchResult
} from '@personal-agent/protocol'
import type {
  KnowledgeImportIpcResult,
  KnowledgeListIpcResult,
  KnowledgeSearchIpcResult
} from '../../shared/ipc-contract'

export interface KnowledgeIpcDeps {
  selectFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  request: (
    method: string,
    params: unknown,
    options?: { timeoutMs: number | null }
  ) => Promise<unknown>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function importKnowledge(
  input: unknown,
  deps: KnowledgeIpcDeps
): Promise<KnowledgeImportIpcResult> {
  try {
    const options = input as { mode?: unknown; force?: unknown } | null
    const mode = KnowledgeMode.parse(options?.mode)
    if (options?.force !== undefined && typeof options.force !== 'boolean')
      throw new Error('force 必须为布尔值')
    const selected = await deps.selectFiles()
    if (selected.canceled) return { ok: true, entries: [] }
    const params = KnowledgeImportParams.parse({
      paths: selected.filePaths,
      mode,
      force: options?.force ?? false
    })
    return KnowledgeImportResult.parse(
      await deps.request('knowledge.import', params, { timeoutMs: null })
    )
  } catch (error) {
    return { ok: false, message: message(error) }
  }
}

export async function listKnowledge(deps: KnowledgeIpcDeps): Promise<KnowledgeListIpcResult> {
  try {
    return KnowledgeListResult.parse(await deps.request('knowledge.list', {}))
  } catch (error) {
    return { ok: false, message: message(error) }
  }
}

export async function searchKnowledge(
  input: unknown,
  deps: KnowledgeIpcDeps
): Promise<KnowledgeSearchIpcResult> {
  try {
    const params = KnowledgeSearchParams.parse(input)
    return KnowledgeSearchResult.parse(
      await deps.request('knowledge.search', params, { timeoutMs: null })
    )
  } catch (error) {
    return { ok: false, message: message(error) }
  }
}
