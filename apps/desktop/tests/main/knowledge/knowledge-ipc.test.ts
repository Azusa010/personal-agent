import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  importKnowledge,
  listKnowledge,
  searchKnowledge
} from '../../../src/main/knowledge/knowledge-ipc'
import type { KnowledgeIpcDeps } from '../../../src/main/knowledge/knowledge-ipc'

function dependencies(): {
  selectFiles: Mock<KnowledgeIpcDeps['selectFiles']>
  request: Mock<KnowledgeIpcDeps['request']>
} {
  return {
    selectFiles: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['D:/guide.md'] }),
    request: vi.fn()
  }
}

describe('knowledge IPC', () => {
  it.each(['traditional', 'raptor', 'viking'])(
    'imports selected files in %s mode',
    async (mode) => {
      const deps = dependencies()
      deps.request.mockResolvedValue({
        ok: true,
        entries: [{ sourcePath: 'D:/guide.md', mode, status: 'indexed', chunkCount: 2 }]
      })
      const result = await importKnowledge({ mode, force: true }, deps)
      expect(result.ok).toBe(true)
      expect(deps.request).toHaveBeenCalledWith(
        'knowledge.import',
        { paths: ['D:/guide.md'], mode, force: true },
        { timeoutMs: null }
      )
    }
  )
  it('does not import on cancel or open the picker for invalid options', async () => {
    const deps = dependencies()
    expect((await importKnowledge({ mode: 'wrong' }, deps)).ok).toBe(false)
    expect((await importKnowledge({ mode: 'viking', force: 'yes' }, deps)).ok).toBe(false)
    expect(deps.selectFiles).not.toHaveBeenCalled()
    deps.selectFiles.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await importKnowledge({ mode: 'viking' }, deps)).toEqual({ ok: true, entries: [] })
    expect(deps.request).not.toHaveBeenCalled()
  })
  it('validates runtime responses and surfaces unavailable runtime', async () => {
    const deps = dependencies()
    deps.request.mockResolvedValue({ ok: true, documents: [] })
    expect(await listKnowledge(deps)).toEqual({ ok: true, documents: [] })
    deps.request.mockResolvedValue({ ok: true })
    expect((await listKnowledge(deps)).ok).toBe(false)
    deps.request.mockRejectedValue(new Error('runtime 未启动'))
    expect(await importKnowledge({ mode: 'viking' }, deps)).toEqual({
      ok: false,
      message: 'runtime 未启动'
    })
  })
  it('searches the selected backend and rejects invalid query', async () => {
    const deps = dependencies()
    const result = { ok: true, query: '火星', totalFound: 0, chunks: [] }
    deps.request.mockResolvedValue(result)
    expect(await searchKnowledge({ query: '火星', mode: 'raptor' }, deps)).toEqual(result)
    expect(deps.request).toHaveBeenCalledWith(
      'knowledge.search',
      { query: '火星', mode: 'raptor', topK: 5 },
      { timeoutMs: null }
    )
    deps.request.mockClear()
    expect((await searchKnowledge({ query: '' }, deps)).ok).toBe(false)
    expect(deps.request).not.toHaveBeenCalled()
  })
})
