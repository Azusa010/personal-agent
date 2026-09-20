import React, { useState } from 'react'
import { AlertCircle, Check, ChevronRight, Code, Copy, Eye, EyeOff, Wrench } from 'lucide-react'
import { redactSensitiveData } from '../redact'
import type { ToolStepView } from '../types'
import { TextShimmer } from './TextShimmer'

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

  const [expanded, setExpanded] = useState<boolean>(
    defaultExpanded !== undefined ? defaultExpanded : isFailed
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

  const formattedDuration =
    step.durationMs !== undefined
      ? step.durationMs >= 1000
        ? `${(step.durationMs / 1000).toFixed(1)}s`
        : `${step.durationMs}ms`
      : null

  return (
    <div
      className="flex flex-col gap-1 w-full my-0.5 group"
      role="region"
      aria-label={`工具调用: ${step.capability}`}
    >
      {/* 官方 agent-elements 风格的 ToolRowBase 行 */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 max-w-full select-none cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5"
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
        <span className="flex items-center justify-center size-3 shrink-0 text-muted-foreground">
          <Wrench size={11} />
        </span>

        <span className="font-[450] whitespace-nowrap shrink-0">
          {isRunning ? (
            <TextShimmer duration={1.2} className="text-xs">
              {step.capability}
            </TextShimmer>
          ) : (
            <span>{step.capability}</span>
          )}
        </span>

        {!expanded && (
          <span className="truncate min-w-0 flex-1 text-[11px] text-muted-foreground/60 font-mono">
            {JSON.stringify(displayArgs).slice(0, 40)}
          </span>
        )}

        <div className="flex items-center gap-1 ml-auto shrink-0 text-[11px] font-mono text-muted-foreground/70">
          {formattedDuration && <span>{formattedDuration}</span>}

          {isFailed && (
            <span className="flex items-center gap-0.5 text-destructive font-medium">
              <AlertCircle size={11} /> 失败
            </span>
          )}

          <button
            type="button"
            onClick={handleCopy}
            title="复制"
            aria-label="复制参数与结果"
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-foreground transition-opacity"
          >
            {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
          </button>

          {onInspectRaw && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onInspectRaw(step)
              }}
              title="原始数据"
              aria-label="查看原始 Span JSON"
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-foreground transition-opacity"
            >
              <Code size={11} />
            </button>
          )}

          <ChevronRight
            size={12}
            className={`shrink-0 text-muted-foreground transition-transform duration-150 ease-out ${
              expanded ? 'rotate-90' : 'rotate-0'
            }`}
          />
        </div>
      </div>

      {/* 官方展开面板：左侧细线与简洁缩进 */}
      {expanded && (
        <div className="pl-3.5 ml-1 border-l border-border/50 py-1 space-y-2 text-xs">
          {/* 参数 */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-0.5">
              <span>调用参数</span>
              <button
                type="button"
                onClick={() => setShowRedacted(!showRedacted)}
                className="flex items-center gap-1 text-[10px] text-primary/80 hover:underline"
              >
                {showRedacted ? <Eye size={10} /> : <EyeOff size={10} />}
                {showRedacted ? '显示完整' : '恢复脱敏'}
              </button>
            </div>
            <pre className="rounded border border-border/30 bg-muted/20 p-2 font-mono text-[11px] text-foreground/80 overflow-x-auto max-h-32 overflow-y-auto">
              {JSON.stringify(displayArgs, null, 2)}
            </pre>
          </div>

          {/* 结果 */}
          {displayObs !== undefined && (
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">执行结果</div>
              <pre className="rounded border border-border/30 bg-muted/20 p-2 font-mono text-[11px] text-foreground/80 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                {typeof displayObs === 'string' ? displayObs : JSON.stringify(displayObs, null, 2)}
              </pre>
            </div>
          )}

          {/* 失败重试 */}
          {step.error && (
            <div className="rounded border border-destructive/20 bg-destructive/5 p-2 text-destructive text-xs space-y-1">
              <div className="flex items-center justify-between font-medium">
                <span className="flex items-center gap-1 text-[11px]">
                  <AlertCircle size={12} />
                  {step.error.code ? `[${step.error.code}] ` : ''}
                  {step.error.message}
                </span>
                {onRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(step)}
                    className="rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-destructive/90"
                  >
                    重试
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
