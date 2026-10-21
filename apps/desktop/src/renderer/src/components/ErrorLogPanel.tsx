import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Download, FolderOpen, RefreshCw, Trash2 } from 'lucide-react'

import type { LogGroupView, LogRecordView } from '../../../shared/ipc-contract'
import { cn } from '@renderer/lib/utils'
import { Button } from './ui/button'

const RANGES = [
  { days: 1, label: '今天' },
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' }
] as const

const LEVEL_STYLES: Record<string, string> = {
  fatal: 'bg-destructive/15 text-destructive',
  error: 'bg-destructive/10 text-destructive',
  warn: 'bg-warning/15 text-warning',
  info: 'bg-info/10 text-info',
  debug: 'bg-muted text-muted-foreground'
}

const SOURCE_LABELS: Record<string, string> = {
  main: '主进程',
  python: 'Agent',
  renderer: '界面'
}

function formatTime(iso: string): string {
  const stamp = Date.parse(iso)
  if (!Number.isFinite(stamp)) return iso
  const date = new Date(stamp)
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function ErrorLogPanel(): React.JSX.Element {
  const [days, setDays] = useState<number>(7)
  const [groups, setGroups] = useState<LogGroupView[] | null>(null)
  const [records, setRecords] = useState<LogRecordView[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [grouped, listed] = await Promise.all([
        window.personalAgent.groupLogs({ days }),
        window.personalAgent.listLogs({ limit: 500 })
      ])
      if (!grouped.ok) {
        setError(grouped.message)
        setGroups([])
      } else {
        setGroups(grouped.groups)
        setError(null)
      }
      setRecords(listed.ok ? listed.records : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setGroups([])
    }
  }, [days])

  useEffect(() => {
    const timer = setTimeout(() => {
      void load()
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [load])

  const refresh = (): void => {
    setBusy(true)
    void load().finally(() => setBusy(false))
  }

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.personalAgent.exportLogs({ days })
      setNotice(result.ok ? `已导出到 ${result.path}` : `导出失败：${result.message}`)
    } catch (err) {
      setNotice(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.personalAgent.clearLogs()
      setNotice(result.ok ? `已删除 ${result.deleted} 个日志文件` : `清空失败：${result.message}`)
      await load()
    } catch (err) {
      setNotice(`清空失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleOpenDir = async (): Promise<void> => {
    try {
      await window.personalAgent.openLogsDir()
    } catch {
      setNotice('打开目录失败')
    }
  }

  const detailOf = (fingerprint: string): LogRecordView[] =>
    records.filter((record) => record.fingerprint === fingerprint).slice(0, 20)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-[2px] rounded-[8px] bg-muted p-[2px]">
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              onClick={() => setDays(range.days)}
              className={cn(
                'rounded-[6px] px-2.5 py-1 text-[12px] transition-colors',
                days === range.days
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {range.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={refresh} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />
            刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleOpenDir()}>
            <FolderOpen size={14} />
            目录
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleExport()} disabled={busy}>
            <Download size={14} />
            导出
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleClear()} disabled={busy}>
            <Trash2 size={14} />
            清空
          </Button>
        </div>
      </div>

      {notice !== null && (
        <div className="rounded-[8px] border border-border bg-muted/40 px-3 py-2 text-[11.5px] text-muted-foreground">
          {notice}
        </div>
      )}

      {error !== null && (
        <div className="rounded-[8px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          读取失败：{error}
        </div>
      )}

      {groups !== null && groups.length === 0 && error === null ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-border py-14 text-center">
          <span className="text-[12.5px] text-foreground">这段时间没有错误</span>
          <span className="text-[11px] text-muted-foreground">
            只统计 error 及以上；更细的调用轨迹到目录里翻 jsonl
          </span>
        </div>
      ) : null}

      <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
        {(groups ?? []).map((group) => {
          const isOpen = expanded === group.fingerprint
          const details = isOpen ? detailOf(group.fingerprint) : []
          return (
            <div key={group.fingerprint}>
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : group.fingerprint)}
                className="flex w-full items-start gap-2 bg-background px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
              >
                <span className="mt-[2px] text-muted-foreground">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <span
                  className={cn(
                    'mt-[1px] shrink-0 rounded-[5px] px-1.5 py-[1px] text-[10.5px] font-medium uppercase',
                    LEVEL_STYLES[group.level] ?? LEVEL_STYLES['info']
                  )}
                >
                  {group.level}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-foreground">
                    {group.message}
                  </span>
                  <span className="mt-[2px] flex flex-wrap items-center gap-x-2 gap-y-[2px] text-[10.5px] text-muted-foreground">
                    <span className="font-mono">{group.event}</span>
                    <span>{SOURCE_LABELS[group.source] ?? group.source}</span>
                    {group.taskId !== undefined && (
                      <span className="font-mono">task:{group.taskId.slice(0, 8)}</span>
                    )}
                    <span>{formatTime(group.lastTs)}</span>
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-[1px] text-[10.5px] text-foreground">
                  {group.count}
                </span>
              </button>

              {isOpen && (
                <div className="space-y-2 border-t border-border bg-card px-3 py-2.5">
                  <div className="text-[10.5px] text-muted-foreground">
                    指纹 <span className="font-mono">{group.fingerprint.slice(0, 12)}</span> · 首次{' '}
                    {formatTime(group.firstTs)} · 最近 {formatTime(group.lastTs)}
                  </div>
                  {details.map((record) => (
                    <div
                      key={record.id}
                      className="rounded-[8px] border border-border bg-background p-2"
                    >
                      <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
                        <span>{formatTime(record.ts)}</span>
                        <span className="font-mono">{record.id.slice(0, 8)}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-[11.5px] text-foreground">
                        {record.message}
                      </div>
                      {record.code !== undefined && (
                        <div className="mt-1 font-mono text-[10.5px] text-muted-foreground">
                          {record.code}
                        </div>
                      )}
                      {record.stack !== undefined && (
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-code-bg p-1.5 text-[10.5px] leading-[1.5] text-muted-foreground">
                          {record.stack}
                        </pre>
                      )}
                      {record.context !== undefined && (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-code-bg p-1.5 text-[10.5px] leading-[1.5] text-muted-foreground">
                          {JSON.stringify(record.context, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                  {details.length === 0 && (
                    <div className="text-[11px] text-muted-foreground">
                      最近 500 条里没有该指纹的记录（可能更早了）
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {groups === null && (
        <div className="py-8 text-center text-[12px] text-muted-foreground">读取中…</div>
      )}
    </div>
  )
}
