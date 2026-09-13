import { useEffect, useState } from 'react'
import type { IndexedPdfsResult } from '../../../shared/ipc-contract'
import { formatOccurredAt } from '../view-model'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

export interface IndexDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 随 Dialog 开合挂载/卸载：打开时拉一次索引，关掉状态自然丢弃，不需要手动重置 */
function IndexBody(): React.JSX.Element {
  const [result, setResult] = useState<IndexedPdfsResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.personalAgent.indexedPdfs().then((loaded) => {
      if (!cancelled) setResult(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      {result === null && <p className="text-[12px] text-muted-foreground">读取中…</p>}
      {result !== null && !result.ok && (
        <p className="text-[12px] text-destructive">
          读取失败（{result.code}）：{result.message}
        </p>
      )}
      {result !== null && result.ok && result.entries.length === 0 && (
        <p className="text-[12px] text-muted-foreground">索引为空，先用回形针扫描 Downloads。</p>
      )}
      {result !== null && result.ok && result.entries.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>文件名</TableHead>
              <TableHead>首次扫描</TableHead>
              <TableHead>最近扫描</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.entries.map((entry) => (
              <TableRow key={entry.absolutePath}>
                <TableCell className="font-mono text-[12px]">{entry.name}</TableCell>
                <TableCell className="text-[12px] text-muted-foreground">
                  {formatOccurredAt(entry.firstSeenAt)}
                </TableCell>
                <TableCell className="text-[12px] text-muted-foreground">
                  {formatOccurredAt(entry.lastSeenAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )
}

export function IndexDialog({ open, onOpenChange }: IndexDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>索引管理</DialogTitle>
          <DialogDescription>当前索引里的 PDF 与最近一次扫描时间。</DialogDescription>
        </DialogHeader>
        {open && <IndexBody />}
      </DialogContent>
    </Dialog>
  )
}
