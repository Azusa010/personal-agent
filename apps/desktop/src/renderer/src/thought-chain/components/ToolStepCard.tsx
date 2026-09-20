import React, { useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Wrench
} from 'lucide-react'
import { redactSensitiveData } from '../redact'
import type { ToolStepView } from '../types'

export interface ToolStepCardProps {
  step: ToolStepView
  isStreaming?: boolean
  defaultExpanded?: boolean
  onRetry?: (step: ToolStepView) => void
  onInspectRaw?: (step: ToolStepView) => void
}

export const ToolStepCard: React.FC<ToolStepCardProps> = ({
  step,
  defaultExpanded,
  onRetry,
  onInspectRaw
}) => {
  const isFailed = step.status === 'failed'
  const isRunning = step.status === 'running'

  // 失败时强制展开，否则默认折叠（可通过 defaultExpanded 覆盖）
  const [expanded, setExpanded] = useState<boolean>(
    defaultExpanded !== undefined ? defaultExpanded : isFailed || isRunning
  )
  const [showRedacted, setShowRedacted] = useState(true)
  const [copied, setCopied] = useState(false)

  const displayArgs = showRedacted ? redactSensitiveData(step.arguments) : step.arguments
  const displayObs = showRedacted ? redactSensitiveData(step.observation) : step.observation

  const handleCopy = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    const payload = JSON.stringify(
      {
        capability: step.capability,
        arguments: displayArgs,
        result: displayObs,
        error: step.error
      },
      null,
      2
    )
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div
      className={`rounded-lg border transition-all ${
        isFailed
          ? 'border-destructive/40 bg-destructive/5'
          : 'border-border/60 bg-card/60 hover:border-border'
      }`}
      role="region"
      aria-label={`工具调用: ${step.capability}`}
    >
      {/* 摘要 Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-xs rounded-lg hover:bg-accent/40 transition-colors"
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded(!expanded)
          }
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>

          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-secondary text-foreground">
            <Wrench size={12} />
          </div>

          <span className="font-mono text-xs font-semibold text-foreground truncate">
            {step.capability}
          </span>

          {!expanded && (
            <span className="hidden sm:inline font-mono text-[11px] text-muted-foreground truncate max-w-[240px]">
              {JSON.stringify(displayArgs).slice(0, 50)}...
            </span>
          )}
        </div>

        {/* 状态与统计 */}
        <div className="flex items-center gap-2 text-xs font-mono">
          {step.durationMs !== undefined && (
            <span className="text-muted-foreground">
              {step.durationMs > 1000
                ? `${(step.durationMs / 1000).toFixed(1)}s`
                : `${step.durationMs}ms`}
            </span>
          )}

          {isRunning && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded text-[11px]">
              <Loader2 size={11} className="animate-spin" /> 执行中
            </span>
          )}

          {step.status === 'success' && (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.5 rounded text-[11px]">
              <CheckCircle2 size={11} /> 成功
            </span>
          )}

          {isFailed && (
            <span className="flex items-center gap-1 text-destructive bg-destructive/10 px-1.5 py-0.5 rounded text-[11px] font-medium">
              <AlertCircle size={11} /> 失败
            </span>
          )}

          {/* 快捷操作 */}
          <div className="flex items-center ml-1 border-l border-border pl-1.5 gap-0.5">
            <button
              type="button"
              onClick={handleCopy}
              title="复制参数与结果"
              aria-label="复制参数与结果"
              className="p-1 rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            </button>
            {onInspectRaw && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onInspectRaw(step)
                }}
                title="查看原始 Span JSON"
                aria-label="查看原始 Span JSON"
                className="p-1 rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Code size={12} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 展开详情 */}
      {expanded && (
        <div className="border-t border-border/40 px-3.5 py-2.5 text-xs space-y-2.5">
          {/* 参数 */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium mb-1">
              <span>调用参数</span>
              <button
                type="button"
                onClick={() => setShowRedacted(!showRedacted)}
                className="flex items-center gap-1 text-[10px] text-primary hover:underline"
              >
                {showRedacted ? <Eye size={11} /> : <EyeOff size={11} />}
                {showRedacted ? '显示完整内容' : '恢复隐私脱敏'}
              </button>
            </div>
            <pre className="rounded border border-border/50 bg-background/80 p-2 font-mono text-[11px] text-foreground overflow-x-auto max-h-36 overflow-y-auto">
              {JSON.stringify(displayArgs, null, 2)}
            </pre>
          </div>

          {/* 观察结果 */}
          {displayObs !== undefined && (
            <div>
              <div className="text-[11px] text-muted-foreground font-medium mb-1">执行结果</div>
              <pre className="rounded border border-border/50 bg-background/80 p-2 font-mono text-[11px] text-foreground overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
                {typeof displayObs === 'string' ? displayObs : JSON.stringify(displayObs, null, 2)}
              </pre>
            </div>
          )}

          {/* 错误诊断 */}
          {step.error && (
            <div className="rounded border border-destructive/30 bg-destructive/10 p-2.5 text-destructive text-xs space-y-1.5">
              <div className="flex items-center justify-between font-medium">
                <span className="flex items-center gap-1">
                  <AlertCircle size={13} />
                  {step.error.code ? `[${step.error.code}] ` : ''}
                  {step.error.message}
                </span>
                {onRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(step)}
                    className="rounded bg-destructive px-2 py-0.5 text-[11px] font-medium text-white hover:bg-destructive/90 transition-colors"
                  >
                    重试
                  </button>
                )}
              </div>
              {step.error.stack && (
                <pre className="font-mono text-[10px] text-destructive/80 overflow-x-auto max-h-20">
                  {step.error.stack}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
