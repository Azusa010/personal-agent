import { useEffect, useState } from 'react'
import { ScanSearch } from 'lucide-react'
import type { ListPdfsResult, RuntimeStatus } from '../../../shared/ipc-contract'
import { formatOccurredAt } from '../view-model'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

export interface DiagnosticsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 随 Dialog 开合挂载/卸载：打开时读一次运行时状态，扫描结果由按钮触发 */
function DiagnosticsBody(): React.JSX.Element {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [scan, setScan] = useState<ListPdfsResult | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.personalAgent.runtimeStatus().then((loaded) => {
      if (!cancelled) setStatus(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const rescan = (): void => {
    setScanning(true)
    void window.personalAgent
      .listPdfs('downloads')
      .then((result) => {
        setScan(result)
        setScanning(false)
      })
      .catch(() => setScanning(false))
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 text-[12px] text-muted-foreground">
          {status === null ? '读取运行时状态中…' : `运行时状态：${status.state}`}
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={rescan} disabled={scanning}>
          <ScanSearch size={14} />
          {scanning ? '扫描中…' : '扫描 Downloads'}
        </Button>
      </div>

      {status !== null && (
        <pre className="max-h-40 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(status, null, 2)}
        </pre>
      )}

      {scan !== null && !scan.ok && (
        <p className="text-[12px] text-destructive">
          扫描失败（{scan.code}）：{scan.message}
        </p>
      )}
      {scan !== null && scan.ok && scan.entries.length === 0 && (
        <p className="text-[12px] text-muted-foreground">Downloads 里没有 PDF。</p>
      )}
      {scan !== null && scan.ok && scan.entries.length > 0 && (
        <>
          <p className="m-0 text-[12px] text-muted-foreground">
            扫到 {scan.entries.length} 份 PDF，已写入索引。
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>文件名</TableHead>
                <TableHead>文件修改时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scan.entries.map((entry) => (
                <TableRow key={entry.absolutePath}>
                  <TableCell className="font-mono text-[12px]">{entry.name}</TableCell>
                  <TableCell className="text-[12px] text-muted-foreground">
                    {formatOccurredAt(entry.modifiedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </>
  )
}

export function DiagnosticsDialog({
  open,
  onOpenChange
}: DiagnosticsDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>运行诊断</DialogTitle>
          <DialogDescription>运行时状态与 Downloads 目录扫描结果。</DialogDescription>
        </DialogHeader>
        {open && <DiagnosticsBody />}
      </DialogContent>
    </Dialog>
  )
}
