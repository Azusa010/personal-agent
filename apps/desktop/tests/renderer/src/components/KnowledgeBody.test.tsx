import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeBody } from '../../../../src/renderer/src/components/IndexDialog'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, mounted: false }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown): [unknown, (next: unknown) => void] => {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = value
    return [
      hooks.values[index],
      (next: unknown): void => {
        hooks.values[index] = next
      }
    ]
  },
  useEffect: (effect: () => void): void => {
    if (!hooks.mounted) {
      hooks.mounted = true
      effect()
    }
  }
}))

interface Props {
  children?: React.ReactNode
  onClick?: () => void
  onChange?: (event: { target: { value: string; checked?: boolean } }) => void
  onSubmit?: (event: { preventDefault: () => void }) => void
  disabled?: boolean
  value?: string
  role?: string
  title?: string
}
function elements(node: React.ReactNode): React.ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!React.isValidElement<Props>(node)) return []
  return [node, ...elements(node.props.children)]
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (React.isValidElement<Props>(node)) return text(node.props.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}
function render(): React.ReactElement {
  hooks.index = 0
  return KnowledgeBody()
}
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('knowledge management', () => {
  const list = vi.fn()
  const ingest = vi.fn()
  const search = vi.fn()
  beforeEach(() => {
    hooks.values = []
    hooks.index = 0
    hooks.mounted = false
    list.mockReset().mockResolvedValue({ ok: true, documents: [] })
    ingest.mockReset().mockResolvedValue({
      ok: true,
      entries: [{ sourcePath: 'guide.md', mode: 'viking', status: 'indexed', chunkCount: 2 }]
    })
    search.mockReset().mockResolvedValue({
      ok: true,
      query: '火星',
      totalFound: 1,
      chunks: [
        {
          id: '1',
          fileName: 'guide.md',
          sourcePath: 'D:/guide.md',
          pageNumbers: [2],
          rawText: '预算 120 万元',
          score: 1
        }
      ]
    })
    vi.stubGlobal('window', {
      personalAgent: { knowledgeList: list, knowledgeImport: ingest, knowledgeSearch: search }
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('imports in the chosen mode, refreshes the list and shows the result', async () => {
    render()
    await flush()
    let tree = render()
    expect(text(tree)).toContain('暂无文档')
    expect(text(tree)).not.toContain('需要配置')
    expect(text(tree)).not.toContain('入库后也可')
    elements(tree)
      .find((e) => e.props.value === 'viking')
      ?.props.onChange?.({ target: { value: 'viking' } })
    tree = render()
    elements(tree)
      .find((e) => text(e.props.children) === '导入文件')
      ?.props.onClick?.()
    expect(elements(render()).some((e) => e.props.disabled)).toBe(true)
    await flush()
    expect(ingest).toHaveBeenCalledWith('viking', false)
    expect(list).toHaveBeenCalledTimes(2)
    expect(text(render())).toContain('guide.md：已入库')
  })
  it('searches and presents source text and page references', async () => {
    render()
    await flush()
    let tree = render()
    elements(tree)
      .find((e) => e.props.value === '')
      ?.props.onChange?.({ target: { value: '火星' } })
    tree = render()
    elements(tree)
      .find((e) => e.type === 'form')
      ?.props.onSubmit?.({ preventDefault: vi.fn() })
    await flush()
    expect(search).toHaveBeenCalledWith('火星', 'traditional')
    expect(text(render())).toContain('预算 120 万元')
    expect(text(render())).toContain('第 2 页')
    expect(text(render())).not.toContain('D:/guide.md')
    expect(elements(render()).some((e) => e.props.title === 'D:/guide.md')).toBe(true)
  })
  it('reports failures and releases controls for retry', async () => {
    render()
    await flush()
    ingest.mockRejectedValue(new Error('runtime 离线'))
    elements(render())
      .find((e) => text(e.props.children) === '导入文件')
      ?.props.onClick?.()
    await flush()
    const tree = render()
    expect(elements(tree).some((e) => e.props.role === 'alert')).toBe(true)
    expect(text(tree)).toContain('runtime 离线')
    expect(elements(tree).find((e) => text(e.props.children) === '导入文件')?.props.disabled).toBe(
      false
    )
  })
})
