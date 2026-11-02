import { useEffect, useState } from 'react'
import type {
  KnowledgeDocument,
  KnowledgeMode,
  KnowledgeSearchResult
} from '@personal-agent/protocol'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

export interface IndexDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const MODES: { value: KnowledgeMode; label: string }[] = [
  { value: 'traditional', label: '传统' },
  { value: 'raptor', label: 'RAPTOR 树状' },
  { value: 'viking', label: '本地 Viking' }
]

export function KnowledgeBody(): React.JSX.Element {
  const [mode, setMode] = useState<KnowledgeMode>('traditional')
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [force, setForce] = useState(false)
  const [error, setError] = useState('')
  const [notices, setNotices] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<KnowledgeSearchResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.personalAgent
      .knowledgeList()
      .then((result) => {
        if (cancelled) return
        if (result.ok) setDocuments(result.documents)
        else setError(result.message)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function importFiles(): Promise<void> {
    setBusy(true)
    setError('')
    setNotices([])
    try {
      const result = await window.personalAgent.knowledgeImport(mode, force)
      if (!result.ok) {
        setError(result.message)
        return
      }
      const labels = {
        indexed: '已入库',
        updated: '已更新',
        skipped_unchanged: '已跳过',
        failed: '失败'
      }
      setNotices(
        result.entries.map(
          (e) =>
            `${e.sourcePath.split(/[\\/]/).pop()}：${labels[e.status]}${e.message ? `（${e.message}）` : ''}`
        )
      )
      const list = await window.personalAgent.knowledgeList()
      if (list.ok) setDocuments(list.documents)
      else setError(list.message)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runSearch(): Promise<void> {
    setBusy(true)
    setError('')
    setSearch(null)
    try {
      const result = await window.personalAgent.knowledgeSearch(query.trim(), mode)
      if (result.ok) setSearch(result)
      else setError(result.message)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <fieldset disabled={busy} className="space-y-2">
        <legend className="sr-only">入库与检索方式</legend>
        <div className="flex flex-wrap gap-4">
          {MODES.map((item) => (
            <label key={item.value} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="knowledge-mode"
                value={item.value}
                checked={mode === item.value}
                onChange={() => {
                  setMode(item.value)
                  setSearch(null)
                }}
              />
              {item.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-4">
        <Button
          disabled={busy || loading}
          title="PDF、Markdown、TXT，可多选"
          onClick={() => void importFiles()}
        >
          {busy ? '处理中…' : '导入文件'}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={force}
            disabled={busy}
            onChange={(e) => setForce(e.target.checked)}
          />
          重新入库
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notices.length > 0 && (
        <ul aria-live="polite" className="space-y-1 text-sm">
          {notices.map((n) => (
            <li className="break-all" key={n}>
              {n}
            </li>
          ))}
        </ul>
      )}
      <section aria-label="已入库文档" className="space-y-2">
        <h3 className="text-sm font-medium">文档</h3>
        {loading ? (
          <p role="status">读取中…</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无文档</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>文件</TableHead>
                <TableHead>方式</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <TableRow key={`${doc.mode}:${doc.id}`}>
                  <TableCell title={doc.sourcePath} className="break-all">
                    {doc.fileName}
                  </TableCell>
                  <TableCell>{MODES.find((m) => m.value === doc.mode)?.label}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && query.trim()) void runSearch()
        }}
      >
        <label className="sr-only" htmlFor="knowledge-query">
          搜索知识库
        </label>
        <div className="flex gap-2">
          <Input
            id="knowledge-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索知识库"
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !query.trim()}>
            搜索
          </Button>
        </div>
      </form>
      {search && (
        <section aria-label="检索结果" aria-live="polite" className="space-y-3">
          {search.warnings?.map((w) => (
            <p key={w} className="text-sm text-destructive">
              {w}
            </p>
          ))}
          {search.chunks.length === 0 && (
            <p className="text-sm text-muted-foreground">无匹配结果</p>
          )}
          {search.chunks.map((chunk) => (
            <article key={chunk.id} className="space-y-1 border-t pt-3">
              <p className="text-sm font-medium" title={chunk.sourcePath}>
                {chunk.fileName}
                {chunk.headingPath ? ` · ${chunk.headingPath}` : ''}
                {chunk.pageNumbers.length > 0 ? ` · 第 ${chunk.pageNumbers.join('、')} 页` : ''}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{chunk.rawText}</p>
            </article>
          ))}
        </section>
      )}
    </div>
  )
}

export function IndexDialog({ open, onOpenChange }: IndexDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>知识库</DialogTitle>
          <DialogDescription className="sr-only">导入与搜索文档</DialogDescription>
        </DialogHeader>
        {open && <KnowledgeBody />}
      </DialogContent>
    </Dialog>
  )
}
