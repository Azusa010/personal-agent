import { useEffect, useState } from 'react'
import { ScanSearch } from 'lucide-react'
import type {
  ListPdfsResult,
  PermissionListResult,
  RuntimeStatus
} from '../../../shared/ipc-contract'
import { formatOccurredAt, PERMISSION_STATE_LABELS } from '../view-model'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Separator } from './ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

export interface DiagnosticsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前选中的会话。null 时权限区不发 IPC，只显示提示 */
  taskId: string | null
}

/** 随 Dialog 开合挂载/卸载：打开时读一次运行时状态，扫描结果由按钮触发 */
function DiagnosticsBody({ taskId }: { taskId: string | null }): React.JSX.Element {
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

      <Separator className="my-2" />
      <PermissionSection taskId={taskId} />
    </>
  )
}

/** 权限记录的只读观察区。不写库、不产生副作用，数据走 broker.listForTask。
 *  状态列显示的是投影值（含 expired），不是库里的 status。 */
function PermissionSection({ taskId }: { taskId: string | null }): React.JSX.Element {
  const [result, setResult] = useState<PermissionListResult | null>(null)

  // taskId 为 null 时不发请求：没选中会话就没有「这个任务的权限」可言。
  useEffect(() => {
    if (taskId === null) return
    let cancelled = false
    void window.personalAgent.listPermissions(taskId).then((loaded) => {
      if (!cancelled) setResult(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [taskId])

  const hint = (text: string): React.JSX.Element => (
    <p className="m-0 text-[12px] text-muted-foreground">{text}</p>
  )

  let body: React.JSX.Element
  if (taskId === null) {
    body = hint('先在左侧选一个会话。')
  } else if (result === null) {
    body = hint('读取权限记录中…')
  } else if (!result.ok) {
    body = (
      <p className="m-0 text-[12px] text-destructive">
        读取失败（{result.code}）：{result.message}
      </p>
    )
  } else if (result.entries.length === 0) {
    // 空是预期结果，不是坏了：当前计划全是只读能力，根本不会产生权限记录。
    // 不说清成因的话，这里看上去就像推送或落库断了。
    body = hint(
      '这个会话没有权限记录。当前计划只包含只读能力，WRITE 能力还没接进执行链，所以这里暂时不会有数据。'
    )
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>能力</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>参数指纹</TableHead>
            <TableHead>请求时间</TableHead>
            <TableHead>决定时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.entries.map(({ permission, state }) => (
            <TableRow key={permission.id}>
              <TableCell className="font-mono text-[12px]">{permission.capability}</TableCell>
              <TableCell className="text-[12px]">{PERMISSION_STATE_LABELS[state]}</TableCell>
              <TableCell className="font-mono text-[12px] text-muted-foreground">
                {permission.argsHash.slice(0, 12)}
              </TableCell>
              <TableCell className="text-[12px] text-muted-foreground">
                {formatOccurredAt(permission.requestedAt)}
              </TableCell>
              <TableCell className="text-[12px] text-muted-foreground">
                {permission.decidedAt === null ? '—' : formatOccurredAt(permission.decidedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <section className="space-y-2">
      <h3 className="m-0 text-[13px] font-semibold">权限记录</h3>
      {body}
    </section>
  )
}

export function DiagnosticsDialog({
  open,
  onOpenChange,
  taskId
}: DiagnosticsDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>运行诊断</DialogTitle>
          <DialogDescription>
            运行时状态、Downloads 目录扫描结果与当前会话的权限记录。
          </DialogDescription>
        </DialogHeader>
        {open && <DiagnosticsBody key={taskId ?? 'none'} taskId={taskId} />}
      </DialogContent>
    </Dialog>
  )
}
