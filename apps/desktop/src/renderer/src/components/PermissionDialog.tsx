import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { PermissionDecision, PermissionRecord } from '../../../shared/ipc-contract'
import { formatOccurredAt, formatRemaining } from '../view-model'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

export interface PermissionDialogProps {
  /** null = 没有待批准的请求，Dialog 不打开 */
  permission: PermissionRecord | null
  onDecide: (decision: PermissionDecision) => Promise<void>
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 break-all">{children}</div>
    </div>
  )
}

/** 随 permission 挂载/卸载，key 用 id：换一条请求时倒计时与 submitting 自然重置 */
function PermissionBody({
  permission,
  onDecide
}: {
  permission: PermissionRecord
  onDecide: (decision: PermissionDecision) => Promise<void>
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const expiresMs = new Date(permission.expiresAt).getTime()
  // 窗口关掉只禁用按钮，不替主进程下结论：过期事件与结算都由 broker 推过来。
  const windowClosed = !Number.isNaN(expiresMs) && now >= expiresMs
  const remaining = formatRemaining(permission.expiresAt, now)
  const disabled = submitting || windowClosed

  const decide = async (decision: PermissionDecision): Promise<void> => {
    setSubmitting(true)
    try {
      await onDecide(decision)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="space-y-2.5">
        <Row label="能力">
          <span className="font-mono text-[12px] text-foreground">{permission.capability}</span>
        </Row>

        <Row label="影响文件">
          <span className="text-foreground">{permission.sourcePaths.length} 个</span>
        </Row>

        {permission.sourcePaths.length > 0 && (
          <Row label="来源路径">
            <ul className="m-0 list-none space-y-1 p-0">
              {permission.sourcePaths.map((path) => (
                <li key={path} className="font-mono text-[12px] text-foreground">
                  {path}
                </li>
              ))}
            </ul>
          </Row>
        )}

        {permission.targetPath !== null && (
          <Row label="目标位置">
            <span className="font-mono text-[12px] text-foreground">{permission.targetPath}</span>
          </Row>
        )}

        <Row label="参数摘要">
          <span className="font-mono text-[12px] text-foreground">{permission.argsCanonical}</span>
        </Row>

        <Row label="参数指纹">
          <span className="font-mono text-[12px] text-muted-foreground">
            {permission.argsHash.slice(0, 12)}
          </span>
        </Row>

        <Row label="请求时间">{formatOccurredAt(permission.requestedAt)}</Row>

        <Row label="过期时间">
          <span className="text-foreground">
            {Number.isNaN(expiresMs)
              ? permission.expiresAt
              : formatOccurredAt(permission.expiresAt)}
          </span>
        </Row>

        <Row label="剩余时间">
          {remaining === '' ? (
            <span className="text-muted-foreground">无法解析过期时刻</span>
          ) : (
            <span className={windowClosed ? 'text-destructive' : 'text-foreground'}>
              {remaining}
            </span>
          )}
        </Row>
      </div>

      {windowClosed && (
        <p className="m-0 text-[12px] text-destructive">
          批准窗口已关闭，等待主进程结算。这个操作不会被执行。
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => void decide('denied')}
        >
          拒绝
        </Button>
        <Button type="button" disabled={disabled} onClick={() => void decide('approved')}>
          {submitting ? '提交中…' : '批准'}
        </Button>
      </DialogFooter>
    </>
  )
}

export function PermissionDialog({
  permission,
  onDecide
}: PermissionDialogProps): React.JSX.Element {
  return (
    <Dialog open={permission !== null}>
      <DialogContent
        className="max-w-lg"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert size={16} className="text-destructive" />
            需要你批准
          </DialogTitle>
          <DialogDescription>
            这个操作会改动授权目录里的文件。路径是规范化之后的绝对路径，批准的就是它。
          </DialogDescription>
        </DialogHeader>
        {permission !== null && (
          <PermissionBody key={permission.id} permission={permission} onDecide={onDecide} />
        )}
      </DialogContent>
    </Dialog>
  )
}
