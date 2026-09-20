import React, { useMemo, useState } from 'react'
import {
  AlertCircle,
  Brain,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  ShieldCheck,
  Wrench
} from 'lucide-react'
import type { TaskTimeline } from '../../../../shared/ipc-contract'
import type { LiveStreamState } from '../../view-model'
import { calculateTraceStats, streamStateToSteps, timelineToSteps } from '../transformer'
import type { StepFilter, ThoughtChainStep, ToolStepView } from '../types'
import { NoticeStepCard } from './NoticeStepCard'
import { RawSpanDialog } from './RawSpanDialog'
import { ThoughtStepCard } from './ThoughtStepCard'
import { ToolStepCard } from './ToolStepCard'
import { VerificationStepCard } from './VerificationStepCard'

export interface ThoughtChainViewerProps {
  timeline?: TaskTimeline | null
  liveStream?: LiveStreamState | null
  isStreaming?: boolean
  cachedThinking?: string
  onRetryStep?: (step: ToolStepView) => void
  className?: string
}

export const ThoughtChainViewer: React.FC<ThoughtChainViewerProps> = ({
  timeline = null,
  liveStream = null,
  isStreaming = false,
  cachedThinking,
  onRetryStep,
  className = ''
}) => {
  const [filter, setFilter] = useState<StepFilter>('all')
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null)
  const [inspectStep, setInspectStep] = useState<ThoughtChainStep | null>(null)
  const [copiedMd, setCopiedMd] = useState(false)

  // 转换原始数据为统一的步骤列表
  const steps = useMemo(() => {
    if (liveStream) {
      return streamStateToSteps(liveStream)
    }
    if (timeline) {
      return timelineToSteps(timeline, cachedThinking)
    }
    return []
  }, [timeline, liveStream, cachedThinking])

  const stats = useMemo(() => calculateTraceStats(steps), [steps])

  // 过滤逻辑
  const filteredSteps = useMemo(() => {
    switch (filter) {
      case 'thought':
        return steps.filter((s) => s.type === 'thought')
      case 'tool':
        return steps.filter((s) => s.type === 'tool')
      case 'verification':
        return steps.filter((s) => s.type === 'verification')
      case 'error':
        return steps.filter((s) => s.status === 'failed')
      default:
        return steps
    }
  }, [steps, filter])

  const handleCopyMarkdown = async (): Promise<void> => {
    const lines: string[] = ['# 执行轨迹 (ThoughtChain)', '']
    for (const step of steps) {
      lines.push(`### [${step.status.toUpperCase()}] ${step.title}`)
      if (step.durationMs) lines.push(`*耗时: ${step.durationMs}ms*`)
      if (step.type === 'thought') {
        lines.push('', step.thinkingText)
      } else if (step.type === 'tool') {
        lines.push('', '```json', JSON.stringify(step.arguments, null, 2), '```')
      }
      lines.push('')
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopiedMd(true)
      setTimeout(() => setCopiedMd(false), 1500)
    } catch {
      // ignore
    }
  }

  if (steps.length === 0) {
    return null
  }

  return (
    <div className={`space-y-1 text-left ${className}`}>
      {/* 顶部元数据工具条 (仅在多于 1 步时展示极简控制条，单步思考时完全保持纯净) */}
      {steps.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-1.5 px-0.5 py-0.5 text-xs text-muted-foreground">
          {/* 统计指标 */}
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70">
            <span>共 {stats.totalSteps} 步</span>
            {stats.toolCallsCount > 0 && <span>· 工具 {stats.toolCallsCount} 次</span>}
            {stats.totalDurationMs !== undefined && (
              <span>· 耗时 {(stats.totalDurationMs / 1000).toFixed(1)}s</span>
            )}
            {stats.hasErrors && (
              <span className="flex items-center gap-0.5 text-destructive font-medium">
                <AlertCircle size={11} /> 异常
              </span>
            )}
          </div>

          {/* 过滤器胶囊 */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                filter === 'all'
                  ? 'bg-secondary font-medium text-foreground'
                  : 'hover:bg-secondary/60'
              }`}
            >
              全部
            </button>
            <button
              type="button"
              onClick={() => setFilter('thought')}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                filter === 'thought'
                  ? 'bg-secondary font-medium text-foreground'
                  : 'hover:bg-secondary/60'
              }`}
            >
              <Brain size={11} /> 思考
            </button>
            <button
              type="button"
              onClick={() => setFilter('tool')}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                filter === 'tool'
                  ? 'bg-secondary font-medium text-foreground'
                  : 'hover:bg-secondary/60'
              }`}
            >
              <Wrench size={11} /> 工具
            </button>
            {steps.some((s) => s.type === 'verification') && (
              <button
                type="button"
                onClick={() => setFilter('verification')}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                  filter === 'verification'
                    ? 'bg-secondary font-medium text-foreground'
                    : 'hover:bg-secondary/60'
                }`}
              >
                <ShieldCheck size={11} /> 校验
              </button>
            )}
            {stats.hasErrors && (
              <button
                type="button"
                onClick={() => setFilter('error')}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                  filter === 'error'
                    ? 'bg-destructive text-destructive-foreground font-medium'
                    : 'text-destructive hover:bg-destructive/10'
                }`}
              >
                <AlertCircle size={11} /> 异常
              </button>
            )}

            {/* 全局折叠/展开与导出 */}
            <div className="ml-1 flex items-center border-l border-border/80 pl-1.5 gap-1">
              <button
                type="button"
                onClick={() => setAllExpanded((prev) => !prev)}
                title={allExpanded ? '全部收起' : '全部展开'}
                aria-label={allExpanded ? '全部收起' : '全部展开'}
                className="rounded p-1 hover:bg-secondary hover:text-foreground text-muted-foreground"
              >
                {allExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
              </button>
              <button
                type="button"
                onClick={handleCopyMarkdown}
                title="复制完整轨迹为 Markdown"
                aria-label="复制完整轨迹为 Markdown"
                className="rounded p-1 hover:bg-secondary hover:text-foreground text-muted-foreground"
              >
                {copiedMd ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 步骤卡片流 */}
      <div className="space-y-2">
        {filteredSteps.map((step) => {
          if (step.type === 'thought') {
            return (
              <ThoughtStepCard
                key={step.id}
                step={step}
                isStreaming={isStreaming}
                defaultExpanded={allExpanded !== null ? allExpanded : undefined}
                onInspectRaw={(s) => setInspectStep(s)}
              />
            )
          }
          if (step.type === 'tool') {
            return (
              <ToolStepCard
                key={step.id}
                step={step}
                isStreaming={isStreaming}
                defaultExpanded={allExpanded !== null ? allExpanded : undefined}
                onRetry={onRetryStep}
                onInspectRaw={(s) => setInspectStep(s)}
              />
            )
          }
          if (step.type === 'verification') {
            return (
              <VerificationStepCard
                key={step.id}
                step={step}
                onInspectRaw={(s) => setInspectStep(s)}
              />
            )
          }
          if (step.type === 'notice') {
            return <NoticeStepCard key={step.id} step={step} />
          }
          return null
        })}
      </div>

      {/* 原始 JSON 抽屉 */}
      <RawSpanDialog
        step={inspectStep}
        open={inspectStep !== null}
        onOpenChange={(open) => {
          if (!open) setInspectStep(null)
        }}
      />
    </div>
  )
}
