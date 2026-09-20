import { useEffect, useState } from 'react'
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Circle,
  FileCheck2,
  FolderCheck,
  FolderPlus,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
  XCircle,
  Zap
} from 'lucide-react'
import type { RunWorkflowIpcResult, SummaryFact } from '../../../shared/ipc-contract'
import { Badge } from './ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { cn } from '@renderer/lib/utils'

export interface WorkflowCenterProps {
  onCompleted?: () => void
}

interface WorkflowStepMeta {
  index: number
  title: string
  capability: string
  description: string
  icon: React.JSX.Element
}

const GOLDEN_PATH_STEPS: WorkflowStepMeta[] = [
  {
    index: 1,
    title: '扫描文件',
    capability: 'filesystem.list',
    description: '检索 Downloads 目录下的待处理 PDF 文档',
    icon: <FileCheck2 size={16} />
  },
  {
    index: 2,
    title: '提取页面',
    capability: 'document.extract_pdf',
    description: '提取目标 PDF 的每页文本并抽取核心要点',
    icon: <Sparkles size={16} />
  },
  {
    index: 3,
    title: '创建目录',
    capability: 'filesystem.create_dir',
    description: '在 Downloads 目录下新建 Reading 分类归档目录',
    icon: <FolderPlus size={16} />
  },
  {
    index: 4,
    title: '移动归档',
    capability: 'filesystem.move',
    description: '将已处理的 PDF 文件安全移动到 Reading 目录',
    icon: <FolderCheck size={16} />
  },
  {
    index: 5,
    title: '创建提醒',
    capability: 'scheduler.create',
    description: '设定 1 小时后的系统级到点阅读提醒',
    icon: <CalendarClock size={16} />
  }
]

type StepStatus = 'pending' | 'running' | 'completed' | 'failed'

export function WorkflowCenter({ onCompleted }: WorkflowCenterProps): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(() =>
    Array(GOLDEN_PATH_STEPS.length).fill('pending')
  )
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [result, setResult] = useState<RunWorkflowIpcResult | null>(null)
  const [logs, setLogs] = useState<string[]>([])

  useEffect(() => {
    const unsubscribe = window.personalAgent.onAgentStream((notice) => {
      if (notice.kind === 'event') {
        const ev = notice.event
        if (ev.type === 'task_started') {
          setStepStatuses(['running', 'pending', 'pending', 'pending', 'pending'])
          setLogs((prev) => [...prev, `[开始] 工作流启动 (任务 ID: ${notice.taskId})`])
        } else if (ev.type === 'tool_called') {
          const cap = (ev.payload as { capability?: string })?.capability
          if (cap === 'filesystem.list') {
            setStepStatuses(['running', 'pending', 'pending', 'pending', 'pending'])
            setLogs((prev) => [...prev, `[步骤 1] 正在扫描 Downloads 目录…`])
          } else if (cap === 'document.extract_pdf') {
            setStepStatuses(['completed', 'running', 'pending', 'pending', 'pending'])
            setLogs((prev) => [...prev, `[步骤 2] 正在解析 PDF 页面内容…`])
          } else if (cap === 'filesystem.create_dir') {
            setStepStatuses(['completed', 'completed', 'running', 'pending', 'pending'])
            setLogs((prev) => [...prev, `[步骤 3] 正在创建 Reading 目录…`])
          } else if (cap === 'filesystem.move') {
            setStepStatuses(['completed', 'completed', 'completed', 'running', 'pending'])
            setLogs((prev) => [...prev, `[步骤 4] 正在移动 PDF 至 Reading 目录…`])
          } else if (cap === 'scheduler.create') {
            setStepStatuses(['completed', 'completed', 'completed', 'completed', 'running'])
            setLogs((prev) => [...prev, `[步骤 5] 正在创建阅读提醒…`])
          }
        } else if (ev.type === 'task_completed') {
          setStepStatuses(['completed', 'completed', 'completed', 'completed', 'completed'])
          setLogs((prev) => [...prev, `[完成] 工作流全部步骤执行完毕！`])
        } else if (ev.type === 'task_failed') {
          const reason = (ev.payload as { reason?: string })?.reason ?? '执行失败'
          setStepStatuses((prev) => {
            const next = [...prev]
            const runningIdx = next.findIndex((s) => s === 'running')
            if (runningIdx !== -1) next[runningIdx] = 'failed'
            return next
          })
          setLogs((prev) => [...prev, `[失败] ${reason}`])
        }
      }
    })
    return unsubscribe
  }, [])

  const handleRun = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setResult(null)
    setLogs(['正在建立任务连接…'])
    setStepStatuses(['running', 'pending', 'pending', 'pending', 'pending'])

    try {
      const res = await window.personalAgent.runWorkflow('golden_path', { rootId: 'downloads' })
      setResult(res)
      if (res.ok) {
        setActiveTaskId(res.taskId)
        if (res.status === 'completed') {
          setStepStatuses(['completed', 'completed', 'completed', 'completed', 'completed'])
          onCompleted?.()
        } else {
          setStepStatuses((prev) => {
            const next = [...prev]
            const runningIdx = next.findIndex((s) => s === 'running')
            if (runningIdx !== -1) next[runningIdx] = 'failed'
            return next
          })
        }
      } else {
        setStepStatuses((prev) => prev.map((s) => (s === 'running' ? 'failed' : s)))
      }
    } catch (err) {
      setResult({
        ok: false,
        code: 'RUNTIME_CRASHED',
        message: err instanceof Error ? err.message : String(err)
      })
      setStepStatuses((prev) => prev.map((s) => (s === 'running' ? 'failed' : s)))
    } finally {
      setRunning(false)
    }
  }

  const renderStepStatusIcon = (status: StepStatus): React.JSX.Element => {
    switch (status) {
      case 'running':
        return <LoaderCircle size={18} className="animate-spin text-primary" />
      case 'completed':
        return <CheckCircle2 size={18} className="text-success" />
      case 'failed':
        return <XCircle size={18} className="text-destructive" />
      default:
        return <Circle size={18} className="text-muted-foreground/40" />
    }
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background">
      <header className="flex h-[70px] shrink-0 items-center justify-between border-b border-border px-8">
        <div>
          <h2 className="flex items-center gap-2 text-[16px] font-semibold">
            <Zap size={18} className="text-primary" />
            工作流中心 (Workflow Center)
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            确定性执行 · 零 Token 消耗 · 高可靠业务自动化 · 独立于对话环境
          </p>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl space-y-6 p-8">
        {/* 工作流主卡片 */}
        <Card className="border-border bg-card shadow-xs">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <FolderCheck size={22} />
                </div>
                <div>
                  <CardTitle className="text-[16px]">PDF 自动归档整理 (Golden Path)</CardTitle>
                  <CardDescription className="mt-1 text-[13px]">
                    全自动扫描 Downloads 目录中的 PDF，提取核心要点、自动分类移入 Reading
                    目录并设定阅读提醒。
                  </CardDescription>
                </div>
              </div>
              <div className="flex gap-1.5">
                <Badge variant="secondary">确定性路线</Badge>
                <Badge variant="secondary">零 Token</Badge>
                <Badge variant="outline">高可靠</Badge>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-6 pt-2">
            {/* 静态步骤时间线 */}
            <div className="space-y-3">
              <div className="text-[13px] font-medium text-foreground">执行步骤流水线：</div>
              <div className="grid gap-2.5 sm:grid-cols-1">
                {GOLDEN_PATH_STEPS.map((step, idx) => {
                  const status = stepStatuses[idx]
                  return (
                    <div
                      key={step.index}
                      className={cn(
                        'flex items-center justify-between rounded-lg border p-3 transition-colors',
                        status === 'running'
                          ? 'border-primary/50 bg-primary/5'
                          : status === 'completed'
                            ? 'border-border/80 bg-secondary/30'
                            : status === 'failed'
                              ? 'border-destructive/40 bg-destructive/5'
                              : 'border-border/40 bg-card'
                      )}
                    >
                      <div className="flex items-center gap-3.5">
                        <div className="shrink-0">{renderStepStatusIcon(status)}</div>
                        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                          {step.icon}
                        </div>
                        <div>
                          <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                            <span>
                              {step.index}. {step.title}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground/70">
                              ({step.capability})
                            </span>
                          </div>
                          <div className="text-[12px] text-muted-foreground">
                            {step.description}
                          </div>
                        </div>
                      </div>

                      <div className="text-right text-[11px] font-medium">
                        {status === 'running' && <span className="text-primary">执行中…</span>}
                        {status === 'completed' && <span className="text-success">已完成</span>}
                        {status === 'failed' && <span className="text-destructive">执行失败</span>}
                        {status === 'pending' && (
                          <span className="text-muted-foreground/60">待执行</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 操作栏 */}
            <div className="flex items-center justify-between border-t border-border/60 pt-4">
              <div className="text-[12px] text-muted-foreground">
                {running ? (
                  <span className="flex items-center gap-1.5 text-primary">
                    <LoaderCircle size={14} className="animate-spin" />
                    工作流正在自主执行，遇到写入权限时将弹出确认窗口…
                  </span>
                ) : activeTaskId ? (
                  <span>
                    上次执行任务 ID: <code className="font-mono text-[11px]">{activeTaskId}</code>
                  </span>
                ) : (
                  <span>准备就绪，点击开始自动化归档流程。</span>
                )}
              </div>

              <button
                type="button"
                disabled={running}
                onClick={handleRun}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50"
              >
                {running ? (
                  <>
                    <LoaderCircle size={15} className="animate-spin" />
                    <span>执行中…</span>
                  </>
                ) : result !== null ? (
                  <>
                    <RotateCcw size={15} />
                    <span>重新运行</span>
                  </>
                ) : (
                  <>
                    <Play size={15} />
                    <span>立即运行工作流</span>
                  </>
                )}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* 成果与结果卡片 */}
        {result !== null && (
          <Card
            className={cn(
              'border shadow-xs transition-all',
              result.ok && result.status === 'completed'
                ? 'border-success/40 bg-success/5'
                : 'border-destructive/40 bg-destructive/5'
            )}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2.5">
                {result.ok && result.status === 'completed' ? (
                  <>
                    <CheckCircle2 size={20} className="text-success" />
                    <CardTitle className="text-[15px] text-foreground">归档整理成功完成</CardTitle>
                  </>
                ) : (
                  <>
                    <XCircle size={20} className="text-destructive" />
                    <CardTitle className="text-[15px] text-foreground">工作流未成功完成</CardTitle>
                  </>
                )}
              </div>
              <CardDescription className="text-[13px]">
                {result.ok
                  ? result.status === 'completed'
                    ? result.reply
                    : (result.reason ?? '任务执行未达成预期目标')
                  : result.message}
              </CardDescription>
            </CardHeader>

            {result.ok && result.facts && result.facts.length > 0 && (
              <CardContent className="space-y-3 pt-0">
                <div className="text-[12px] font-medium text-foreground">
                  已提取的关键要点与页码证明（Facts）：
                </div>
                <div className="space-y-2">
                  {result.facts.map((fact: SummaryFact, i: number) => (
                    <div
                      key={i}
                      className="flex items-start justify-between gap-4 rounded-md border border-border/60 bg-card p-2.5 text-[12px]"
                    >
                      <div className="text-foreground leading-relaxed">{fact.text}</div>
                      <div className="flex shrink-0 gap-1">
                        {fact.pageRefs.map((p) => (
                          <Badge key={p} variant="outline" className="text-[10px]">
                            第 {p} 页
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* 实时运行日志控制台 */}
        {logs.length > 0 && (
          <div className="rounded-xl border border-border/60 bg-card p-4">
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">实时执行日志：</div>
            <div className="max-h-40 space-y-1 overflow-y-auto font-mono text-[11px] text-muted-foreground">
              {logs.map((log, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <ArrowRight size={11} className="shrink-0 text-primary/70" />
                  <span>{log}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
