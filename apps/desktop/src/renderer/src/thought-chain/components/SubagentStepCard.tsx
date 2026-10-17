import React, { useState } from 'react'
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Code,
  Compass,
  Copy,
  Layers,
  Sparkles
} from 'lucide-react'
import { MarkdownContent } from '../../components/MarkdownContent'
import type { ToolStepView } from '../types'
import { TextShimmer } from './TextShimmer'

type SubagentPrototype = 'explore' | 'plan' | 'general'

interface ParsedSubagentStep {
  role: string
  goal: string
  prototype: SubagentPrototype
  specificInstructions?: string
  allowedTools?: string[]
  summary?: string
  error?: string
  totalSteps?: number
  durationMs?: number
  runId?: string
}

function parseSubagentStep(step: ToolStepView): ParsedSubagentStep {
  const args = step.arguments ?? {}

  let obsData: Record<string, unknown> | null = null
  let summary = ''
  let obsError: string | undefined = undefined
  let totalSteps: number | undefined = undefined
  let durationMsFromObs: number | undefined = undefined
  let runId: string | undefined = undefined

  if (typeof step.observation === 'object' && step.observation !== null) {
    obsData = step.observation as Record<string, unknown>
    if (typeof obsData.summary === 'string') summary = obsData.summary
    else if (typeof obsData.output === 'string') summary = obsData.output
    if (typeof obsData.error === 'string') obsError = obsData.error
    if (typeof obsData.total_steps === 'number') totalSteps = obsData.total_steps
    if (typeof obsData.duration_ms === 'number') durationMsFromObs = obsData.duration_ms
    if (typeof obsData.run_id === 'string') runId = obsData.run_id
  } else if (typeof step.observation === 'string') {
    try {
      const parsed = JSON.parse(step.observation)
      if (parsed && typeof parsed === 'object') {
        obsData = parsed as Record<string, unknown>
        if (typeof obsData.summary === 'string') summary = obsData.summary
        else if (typeof obsData.output === 'string') summary = obsData.output
        if (typeof obsData.error === 'string') obsError = obsData.error
        if (typeof obsData.total_steps === 'number') totalSteps = obsData.total_steps
        if (typeof obsData.duration_ms === 'number') durationMsFromObs = obsData.duration_ms
        if (typeof obsData.run_id === 'string') runId = obsData.run_id
      } else {
        summary = step.observation
      }
    } catch {
      summary = step.observation
    }
  }

  const rawProto = String(args.prototype || obsData?.prototype || 'general').toLowerCase()
  const prototype: SubagentPrototype =
    rawProto === 'explore' || rawProto === 'plan' ? rawProto : 'general'

  const role = String(args.role || obsData?.role || '子智能体')
  const goal = String(args.goal || obsData?.goal || '')
  const specificInstructions =
    typeof args.specific_instructions === 'string' ? args.specific_instructions : undefined
  const allowedTools = Array.isArray(args.allowed_tools)
    ? (args.allowed_tools as string[])
    : undefined

  const durationMs = step.durationMs ?? durationMsFromObs
  const error = step.error?.message || obsError

  return {
    role,
    goal,
    prototype,
    specificInstructions,
    allowedTools,
    summary: summary || undefined,
    error,
    totalSteps,
    durationMs,
    runId
  }
}

function formatDuration(durationMs?: number): string | null {
  if (durationMs === undefined || durationMs === null || Number.isNaN(durationMs)) {
    return null
  }
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`
  }
  return `${durationMs}ms`
}

interface PrototypeMeta {
  label: string
  Icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>
  badgeClasses: string
}

function getPrototypeMeta(proto: SubagentPrototype): PrototypeMeta {
  switch (proto) {
    case 'explore':
      return {
        label: 'Explore',
        Icon: Compass,
        badgeClasses:
          'rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[-0.01em] bg-blue-500/10 text-blue-400 border border-blue-400/25 shadow-[0_0_12px_rgba(59,130,246,0.15)]'
      }
    case 'plan':
      return {
        label: 'Plan',
        Icon: Layers,
        badgeClasses:
          'rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[-0.01em] bg-purple-500/10 text-purple-400 border border-purple-400/25 shadow-[0_0_12px_rgba(168,85,247,0.15)]'
      }
    case 'general':
    default:
      return {
        label: 'General',
        Icon: Bot,
        badgeClasses:
          'rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[-0.01em] bg-amber-500/10 text-amber-400 border border-amber-400/25 shadow-[0_0_12px_rgba(245,158,11,0.15)]'
      }
  }
}

export interface SubagentStepCardProps {
  step: ToolStepView
  isStreaming?: boolean
  defaultExpanded?: boolean
  onInspectRaw?: (step: ToolStepView) => void
}

export const SubagentStepCard: React.FC<SubagentStepCardProps> = ({
  step,
  defaultExpanded,
  onInspectRaw
}) => {
  const isRunning = step.status === 'running'
  const isFailed = step.status === 'failed'
  const isCompleted = step.status === 'success'

  const parsed = parseSubagentStep(step)
  const protoMeta = getPrototypeMeta(parsed.prototype)
  const ProtoIcon = protoMeta.Icon

  const [userExpanded, setUserExpanded] = useState<boolean | null>(
    defaultExpanded !== undefined ? defaultExpanded : null
  )
  const [copied, setCopied] = useState(false)

  // 运行中保持折叠，完成或失败后默认展开
  const isExpanded = userExpanded !== null ? userExpanded : !isRunning

  const handleToggleExpanded = (): void => {
    setUserExpanded(!isExpanded)
  }

  const handleCopySummary = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!parsed.summary) return
    try {
      await navigator.clipboard.writeText(parsed.summary)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板异常兜底
    }
  }

  const formattedDuration = formatDuration(parsed.durationMs)
  const errorMessage = parsed.error || (isFailed ? '子智能体执行失败' : null)

  return (
    <div
      className="flex flex-col gap-1 w-full my-0.5 group"
      role="region"
      aria-label={`子智能体: ${parsed.role}`}
    >
      {/* 静默内联折叠行（Whisper-light Inline Accordion） */}
      <div
        onClick={handleToggleExpanded}
        className="flex items-center gap-2 select-none cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-all duration-150 py-0.5 tracking-[-0.015em]"
        tabIndex={0}
        role="button"
        aria-expanded={isExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleToggleExpanded()
          }
        }}
      >
        {/* 原型母体微徽章 */}
        <span
          data-testid="subagent-prototype-badge"
          className={`inline-flex items-center gap-1.5 shrink-0 ${protoMeta.badgeClasses}`}
        >
          <ProtoIcon size={11} strokeWidth={1.5} className="shrink-0" />
          <span>{protoMeta.label}</span>
        </span>

        {/* 角色与目标展示 */}
        <span className="font-semibold text-foreground/90 shrink-0 text-xs tracking-[-0.015em]">
          {parsed.role}
        </span>

        {parsed.goal && <span className="text-muted-foreground/40 shrink-0">·</span>}

        {isRunning ? (
          <span className="truncate min-w-0 flex-1 flex items-center gap-1.5 text-xs text-muted-foreground tracking-[-0.01em]">
            <TextShimmer duration={1.2} className="text-xs font-[450]">
              {parsed.goal || '子智能体正在执行中...'}
            </TextShimmer>
            {parsed.totalSteps !== undefined && (
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                ({parsed.totalSteps} 步)
              </span>
            )}
          </span>
        ) : (
          <span
            className="truncate min-w-0 flex-1 text-[11px] text-muted-foreground/80 tracking-[-0.01em]"
            title={parsed.goal}
          >
            {parsed.goal}
          </span>
        )}

        {/* 右侧状态与操作区 */}
        <div className="flex items-center gap-1.5 ml-auto shrink-0 text-[11px] font-mono text-muted-foreground/70 tracking-[-0.015em]">
          {formattedDuration && <span>{formattedDuration}</span>}

          {isRunning && (
            <span className="flex items-center gap-1 text-primary text-[11px] font-medium tracking-[-0.015em]">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/60 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
              </span>
              <span>运行中</span>
            </span>
          )}

          {isFailed && (
            <span className="flex items-center gap-0.5 text-destructive font-medium tracking-[-0.015em]">
              <AlertCircle size={11} strokeWidth={1.5} /> 失败
            </span>
          )}

          {isCompleted && (
            <span className="flex items-center gap-1 text-emerald-500 text-[11px] font-medium tracking-[-0.015em]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span>完成</span>
            </span>
          )}

          {parsed.summary && (
            <button
              type="button"
              onClick={handleCopySummary}
              title="复制蒸馏结论"
              aria-label="复制蒸馏结论"
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-foreground transition-opacity"
            >
              {copied ? (
                <Check size={11} strokeWidth={1.5} className="text-emerald-500" />
              ) : (
                <Copy size={11} strokeWidth={1.5} />
              )}
            </button>
          )}

          {onInspectRaw && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onInspectRaw(step)
              }}
              title="查看原始日志"
              aria-label="查看原始日志"
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-foreground transition-opacity"
            >
              <Code size={11} strokeWidth={1.5} />
            </button>
          )}

          <ChevronRight
            size={12}
            strokeWidth={1.5}
            className={`shrink-0 text-muted-foreground transition-transform duration-150 ease-out ${
              isExpanded ? 'rotate-90' : 'rotate-0'
            }`}
          />
        </div>
      </div>

      {/* 展开内容区：无任何外层卡片框，极细淡线微缩进自然铺开 */}
      {isExpanded && (
        <div className="border-l border-border/50 ml-2 pl-4 py-1.5 space-y-2 text-xs">
          {/* 运行中提示 */}
          {isRunning && (
            <div className="flex items-center gap-2 py-0.5 text-muted-foreground tracking-[-0.01em]">
              <TextShimmer duration={1.2} className="text-xs">
                子智能体正在协同探索执行中...
              </TextShimmer>
            </div>
          )}

          {/* 终局蒸馏结论 */}
          {parsed.summary && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-medium tracking-[-0.015em] text-foreground/80">
                <span className="flex items-center gap-1.5 text-primary/80 font-mono text-[10px]">
                  <Sparkles size={11} strokeWidth={1.5} className="text-primary/80 shrink-0" />
                  <span>终局蒸馏结论</span>
                  {parsed.runId && (
                    <span className="font-mono text-[10px] text-muted-foreground/60">
                      ({parsed.runId})
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleCopySummary}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-secondary"
                  title="复制结论"
                  aria-label="复制蒸馏结论"
                >
                  {copied ? (
                    <Check size={10} strokeWidth={1.5} className="text-emerald-500" />
                  ) : (
                    <Copy size={10} strokeWidth={1.5} />
                  )}
                  <span>{copied ? '已复制' : '复制结论'}</span>
                </button>
              </div>
              <div className="text-foreground/90 leading-relaxed font-sans">
                <MarkdownContent content={parsed.summary} className="text-xs tracking-[-0.01em]" />
              </div>
            </div>
          )}

          {/* 执行完成但无蒸馏结论时的兜底 */}
          {isCompleted && !parsed.summary && !errorMessage && (
            <div className="text-xs text-muted-foreground/70 py-0.5 tracking-[-0.01em]">
              子智能体执行完成，无额外产出结论
            </div>
          )}

          {/* 失败错误展示 */}
          {errorMessage && (
            <div className="flex items-start gap-1.5 text-destructive text-xs py-1 tracking-[-0.015em]">
              <AlertCircle size={12} strokeWidth={1.5} className="shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
