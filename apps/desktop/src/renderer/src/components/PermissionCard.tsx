import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Folder,
  ShieldAlert,
  Terminal,
  X
} from 'lucide-react'
import type { PermissionDecision, PermissionRecord } from '../../../shared/ipc-contract'
import { describeReminderPreview, formatOccurredAt } from '../view-model'
import { Button } from './ui/button'
import { cn } from '@renderer/lib/utils'

export interface PermissionCardProps {
  /** 非空时卡片出现在会话流内;决定后由 App 清空状态、卡片随之消失 */
  permission: PermissionRecord
  onDecide: (decision: PermissionDecision) => Promise<void>
}

function baseName(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  return name.length > 24 ? `${name.slice(0, 23)}…` : name
}

function Row({
  label,
  children,
  className
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid grid-cols-[52px_minmax(0,1fr)] items-start gap-2.5 border-t border-[#f5f5f6] py-[7px] text-[12.5px]',
        className
      )}
    >
      <span className="shrink-0 pt-[3px] text-[11px] text-[#a8a8b0]">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function getCapabilityMeta(capability: string): {
  label: string
  icon: React.ComponentType<{ className?: string; size?: number }>
  badgeClass: string
  description: string
} {
  switch (capability) {
    case 'file_write':
      return {
        label: '写入文件',
        icon: FileText,
        badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        description: '此操作将在授权工作区内新建或完全覆盖文件。请审阅目标路径与内容后再批准。'
      }
    case 'file_edit':
      return {
        label: '修改文件',
        icon: FileText,
        badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        description: '此操作将在现有文件中执行精准局部文本替换。请审阅差异内容后再批准。'
      }
    case 'terminal_execute':
      return {
        label: '终端执行',
        icon: Terminal,
        badgeClass: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
        description: '此操作将在安全受限环境中执行终端命令行。请确保命令安全合规后再批准。'
      }
    case 'filesystem_move':
      return {
        label: '移动重命名',
        icon: Folder,
        badgeClass: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
        description: '此操作将在授权根目录下移动或重命名文件/目录。'
      }
    case 'filesystem_create_dir':
      return {
        label: '创建目录',
        icon: Folder,
        badgeClass: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
        description: '此操作将在授权根目录下创建新目录。'
      }
    case 'scheduler_create':
      return {
        label: '创建提醒',
        icon: Calendar,
        badgeClass: 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400',
        description: '此操作会创建一次性提醒任务。时间是模型解析后的具体时刻，批准的就是它。'
      }
    default:
      return {
        label: capability,
        icon: ShieldAlert,
        badgeClass: 'border-border bg-muted text-muted-foreground',
        description: '此操作将调用外部系统能力。请核验参数无误后再批准。'
      }
  }
}

/** 智能参数与代码预览器：支持 file_write / file_edit / terminal_execute 及通用 JSON 结构化格式化 */
function SmartArgumentsPreview({
  capability,
  argsCanonical
}: {
  capability: string
  argsCanonical: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [isExpanded, setIsExpanded] = useState(true)

  const parsed = useMemo(() => {
    try {
      return JSON.parse(argsCanonical) as Record<string, unknown>
    } catch {
      return null
    }
  }, [argsCanonical])

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }, [])

  // 1. file_write 专属预览：提取文件内容与路径，提供带行数统计的代码预览
  if (capability === 'file_write' && parsed && typeof parsed['content'] === 'string') {
    const content = parsed['content']
    const lines = content.split('\n')
    const charCount = content.length

    return (
      <div className="space-y-1.5 rounded-lg border border-border/80 bg-card overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b border-border/60 text-[11px]">
          <div className="flex items-center gap-2 text-foreground font-medium">
            <FileText size={13} className="text-muted-foreground" />
            <span>写入内容预览</span>
            <span className="text-[10px] text-muted-foreground font-mono">
              ({lines.length} 行 · {charCount} 字符)
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => copyToClipboard(content)}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              {copied ? (
                <>
                  <Check size={11} className="text-emerald-500" />
                  <span className="text-emerald-600 dark:text-emerald-400">已复制</span>
                </>
              ) : (
                <>
                  <Copy size={11} />
                  <span>复制</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setIsExpanded((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
          </div>
        </div>
        {isExpanded && (
          <div className="max-h-60 overflow-y-auto p-3 font-mono text-[11px] leading-5 bg-muted/20 select-text">
            <pre className="m-0 whitespace-pre-wrap break-all text-foreground/90 font-mono">
              {content}
            </pre>
          </div>
        )}
      </div>
    )
  }

  // 2. file_edit 专属预览：提取 oldString 和 newString 呈现直观差异
  if (
    capability === 'file_edit' &&
    parsed &&
    typeof parsed['oldString'] === 'string' &&
    typeof parsed['newString'] === 'string'
  ) {
    const oldStr = parsed['oldString']
    const newStr = parsed['newString']

    return (
      <div className="space-y-2 rounded-lg border border-border/80 bg-card p-3">
        <div className="text-[11px] font-medium text-foreground">文本变更对比</div>
        <div className="space-y-2 text-[11px] font-mono">
          <div className="rounded-md border border-rose-500/20 bg-rose-500/5 p-2.5">
            <div className="text-[10px] uppercase font-bold text-rose-600 dark:text-rose-400 mb-1">
              - 待替换原文本
            </div>
            <pre className="m-0 whitespace-pre-wrap break-all text-rose-950 dark:text-rose-200 max-h-32 overflow-y-auto">
              {oldStr}
            </pre>
          </div>
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5">
            <div className="text-[10px] uppercase font-bold text-emerald-600 dark:text-emerald-400 mb-1">
              + 替换后新文本
            </div>
            <pre className="m-0 whitespace-pre-wrap break-all text-emerald-950 dark:text-emerald-200 max-h-32 overflow-y-auto">
              {newStr}
            </pre>
          </div>
        </div>
      </div>
    )
  }

  // 3. terminal_execute 专属预览：命令行高亮框
  if (capability === 'terminal_execute' && parsed && typeof parsed['command'] === 'string') {
    const cmd = parsed['command']
    return (
      <div className="space-y-1.5 rounded-lg border border-border/80 bg-zinc-950 p-3 text-zinc-100 font-mono text-[12px] shadow-inner">
        <div className="flex items-center justify-between text-[11px] text-zinc-400 border-b border-zinc-800 pb-1.5 mb-2">
          <span>终端命令</span>
          <button
            type="button"
            onClick={() => copyToClipboard(cmd)}
            className="hover:text-zinc-200 transition-colors flex items-center gap-1"
          >
            {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
        <div className="flex items-start gap-2 break-all whitespace-pre-wrap">
          <span className="text-emerald-400 select-none">$</span>
          <span className="text-zinc-100 flex-1">{cmd}</span>
        </div>
      </div>
    )
  }

  // 4. 通用格式化 JSON 预览：格式化并限制最大高度
  const formattedJson = parsed ? JSON.stringify(parsed, null, 2) : argsCanonical

  return (
    <div className="space-y-1.5 rounded-lg border border-border/80 bg-card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b border-border/60 text-[11px]">
        <span className="text-muted-foreground font-mono">参数详情</span>
        <button
          type="button"
          onClick={() => copyToClipboard(formattedJson)}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto p-3 font-mono text-[11px] bg-muted/20 select-text">
        <pre className="m-0 whitespace-pre-wrap break-all text-foreground/90 font-mono">
          {formattedJson}
        </pre>
      </div>
    </div>
  )
}

/**
 * 流内权限审批卡(设计定稿:docs/design/ui-mockup.html · 02)。
 * 取代原模态 PermissionDialog:同样的 respondPermission 契约、同样的倒计时 fail-closed,
 * 只是呈现从「打断式弹窗」改为「会话流里的一张琥珀卡」。
 * 调用方用 key={permission.id} 挂载:换一条请求时倒计时与 submitting 自然重置。
 */
export function PermissionCard({ permission, onDecide }: PermissionCardProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [submitting, setSubmitting] = useState(false)
  // 环形倒计时的分母:挂载那一刻距过期的秒数
  const [totalSec] = useState(() => {
    const expiresMs = new Date(permission.expiresAt).getTime()
    return Number.isNaN(expiresMs) ? 1 : Math.max(1, Math.floor((expiresMs - Date.now()) / 1000))
  })

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const expiresMs = new Date(permission.expiresAt).getTime()
  const windowClosed = !Number.isNaN(expiresMs) && now >= expiresMs
  const disabled = submitting || windowClosed

  const remainingMs = !Number.isNaN(expiresMs) ? expiresMs - now : 0
  const remainingSec = Math.max(0, Math.floor(remainingMs / 1000))
  const isUrgent = remainingSec <= 15 && remainingSec > 0 && !windowClosed

  const decide = useCallback(
    async (decision: PermissionDecision): Promise<void> => {
      setSubmitting(true)
      try {
        await onDecide(decision)
      } finally {
        setSubmitting(false)
      }
    },
    [onDecide]
  )

  // 键盘快捷键:Enter 批准、Esc 拒绝。输入框(写消息/填表单)聚焦时 Enter 不抢,
  // 否则用户在 Composer 里按回车发消息会误触批准。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (disabled) return
      const target = e.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
      if (e.key === 'Enter') {
        if (typing) return
        if (
          target !== null &&
          target.tagName === 'BUTTON' &&
          target.getAttribute('data-action') === 'deny'
        ) {
          return
        }
        e.preventDefault()
        void decide('approved')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        void decide('denied')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [disabled, decide])

  const meta = getCapabilityMeta(permission.capability)
  const Icon = meta.icon
  const preview = describeReminderPreview(permission)
  const ringDeg = windowClosed ? 0 : Math.round((remainingSec / totalSec) * 360)

  const fileCount = permission.sourcePaths.length
  const firstFile = fileCount > 0 ? baseName(permission.sourcePaths[0]) : null
  const title =
    preview !== null
      ? '允许创建这个提醒？'
      : permission.capability === 'filesystem_move'
        ? fileCount > 1
          ? `允许移动 ${fileCount} 个文件？`
          : '允许移动这个文件？'
        : permission.capability === 'terminal_execute'
          ? '允许执行这条命令？'
          : permission.capability === 'file_write' && firstFile !== null
            ? `允许写入 ${firstFile}？`
            : permission.capability === 'file_edit' && firstFile !== null
              ? `允许修改 ${firstFile}？`
              : `允许${meta.label}？`

  return (
    <>
      {/* 面板上方的一层短渐变：让对话在面板边缘淡出，而不是被硬切一刀 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-24 bg-gradient-to-t from-background via-background/70 to-transparent" />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-6">
        <div className="pointer-events-auto w-full max-w-[760px] overflow-hidden rounded-t-[16px] border border-b-0 border-[#e4e4e7] bg-[linear-gradient(180deg,#fff9ea_0,rgba(255,249,234,0)_104px),linear-gradient(#fff,#fff)] shadow-[0_-1px_2px_rgba(9,9,11,0.04),0_-24px_56px_-30px_rgba(9,9,11,0.34)]">
          <div className="grid h-3.5 place-items-center">
            <span className="block h-[3px] w-[30px] rounded-full bg-[#dcdce0]" />
          </div>

          {/* 标题：琥珀图标 + 一句问句 + 倒计时 */}
          <div className="flex items-start gap-2.5 px-[18px] pb-2.5">
            <div className="grid size-[30px] shrink-0 place-items-center rounded-[9px] border border-[var(--amber-line)] bg-[var(--amber-tint)] text-[var(--amber-strong)]">
              <Icon size={15} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold leading-[1.3] tracking-[-0.018em] text-foreground">
                {title}
              </div>
              <div className="mt-[3px] text-[11.5px] text-muted-foreground">
                发起于 {formatOccurredAt(permission.requestedAt)} · 确认后才会执行
              </div>
            </div>
            <div
              className={cn(
                'grid size-[34px] shrink-0 place-items-center rounded-full',
                isUrgent && !windowClosed && 'animate-pulse'
              )}
              style={{
                background: `conic-gradient(${
                  windowClosed ? 'var(--destructive)' : isUrgent ? 'var(--amber-strong)' : '#d97706'
                } ${ringDeg}deg, #fde68a 0)`
              }}
              title="批准窗口剩余时间"
            >
              <div className="grid size-[26px] place-items-center rounded-full bg-background font-mono text-[9.5px] font-semibold text-[#92400e]">
                {windowClosed ? '0' : remainingSec}
              </div>
            </div>
          </div>

          {/* 内容：影响范围 / 目标位置 / 执行说明 / 指纹 */}
          <div className="max-h-[42vh] overflow-y-auto px-[18px]">
            {preview === null ? (
              <>
                {fileCount > 0 && (
                  <Row label="影响范围">
                    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                      {permission.sourcePaths.slice(0, 3).map((path) => (
                        <span
                          key={path}
                          className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-[#fafafa] px-1.5 py-[2px] font-mono text-[10px] text-[#52525b]"
                          title={path}
                        >
                          <FileText size={9} className="shrink-0 text-muted-foreground" />
                          {baseName(path)}
                        </span>
                      ))}
                      {fileCount > 3 && (
                        <span className="text-[11px] text-muted-foreground">
                          另有 {fileCount - 3} 个
                        </span>
                      )}
                    </div>
                  </Row>
                )}

                {permission.targetPath !== null && (
                  <Row label="目标位置">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="inline-flex items-center gap-1 rounded-[5px] border border-[var(--mint-line)] bg-[var(--mint-tint)] px-1.5 py-[2px] font-mono text-[10px] break-all text-[#065f46]">
                        <ArrowRight size={9} className="shrink-0" />
                        {permission.targetPath}
                      </span>
                    </div>
                  </Row>
                )}

                <Row label="执行说明">
                  <span className="text-[12px] leading-[1.6] text-[#52525b]">
                    {meta.description}
                  </span>
                </Row>
              </>
            ) : (
              <>
                <Row label="提醒时间">
                  <span className="text-[12.5px] font-medium text-foreground">
                    {formatOccurredAt(preview.remindAt)}
                  </span>
                </Row>

                {preview.message !== null && (
                  <Row label="提醒内容">
                    <span className="inline-block rounded-[5px] border border-border bg-[#fafafa] px-2 py-[3px] text-[12px] text-foreground">
                      {preview.message}
                    </span>
                  </Row>
                )}
              </>
            )}

            {(permission.capability === 'file_write' ||
              permission.capability === 'file_edit' ||
              permission.capability === 'terminal_execute' ||
              permission.capability === 'scheduler_create') && (
              <Row label="参数">
                <SmartArgumentsPreview
                  capability={permission.capability}
                  argsCanonical={permission.argsCanonical}
                />
              </Row>
            )}

            <div className="flex items-center gap-1.5 border-t border-[#f5f5f6] py-1.5 font-mono text-[9.5px] text-[#b8b8bf]">
              <ShieldAlert size={10} />
              参数指纹 {permission.argsHash.slice(0, 12)}…<span className="text-[#dcdce0]">·</span>
              {windowClosed ? '窗口已关闭，不会执行' : `${remainingSec} 秒后自动拒绝`}
            </div>
          </div>

          {/* 操作区 */}
          <div className="flex items-center justify-between gap-3.5 border-t border-[#f5f5f6] px-[18px] pb-[15px] pt-2.5">
            <div className="flex items-center gap-1.5 text-[10.5px] text-[#b3b3b8]">
              {windowClosed ? (
                <span className="flex items-center gap-1 font-medium text-destructive">
                  <AlertTriangle size={12} />
                  批准窗口已关闭
                </span>
              ) : (
                <span className="hidden items-center gap-1 sm:flex">
                  按{' '}
                  <kbd className="rounded border border-border px-1 py-[1px] font-mono text-[9.5px] text-[#71717a]">
                    Enter
                  </kbd>{' '}
                  批准 ·{' '}
                  <kbd className="rounded border border-border px-1 py-[1px] font-mono text-[9.5px] text-[#71717a]">
                    Esc
                  </kbd>{' '}
                  拒绝
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action="deny"
                disabled={disabled}
                onClick={() => void decide('denied')}
                className="min-w-16"
              >
                <X size={13} className="mr-1 text-muted-foreground" />
                拒绝
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={() => void decide('approved')}
                className={cn(
                  'min-w-[104px] font-medium',
                  permission.capability === 'terminal_execute'
                    ? 'bg-[#be123c] text-white hover:bg-[#9f1239]'
                    : 'bg-foreground text-background hover:bg-foreground/90'
                )}
              >
                <Check size={13} className="mr-1" />
                {submitting ? '提交中…' : '批准并继续'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
