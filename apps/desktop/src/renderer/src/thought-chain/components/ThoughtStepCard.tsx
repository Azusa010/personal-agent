import React, { useState } from 'react'
import { Brain, Check, ChevronDown, ChevronRight, Code, Loader2 } from 'lucide-react'
import type { ThoughtStepView } from '../types'

export interface ThoughtStepCardProps {
  step: ThoughtStepView
  isStreaming?: boolean
  defaultExpanded?: boolean
  onInspectRaw?: (step: ThoughtStepView) => void
}

export const ThoughtStepCard: React.FC<ThoughtStepCardProps> = ({
  step,
  isStreaming = false,
  defaultExpanded,
  onInspectRaw
}) => {
  const isRunning = step.status === 'running'
  const [expanded, setExpanded] = useState<boolean>(
    defaultExpanded !== undefined ? defaultExpanded : isRunning
  )

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isRunning
          ? 'border-indigo-200/80 bg-indigo-50/40 dark:border-indigo-900/50 dark:bg-indigo-950/20'
          : 'border-border/60 bg-card/60'
      }`}
      role="region"
      aria-label={step.title}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-xs hover:bg-accent/40 rounded-lg transition-colors"
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
          <Brain
            size={14}
            className={
              isRunning
                ? 'animate-pulse text-indigo-500 dark:text-indigo-400'
                : 'text-muted-foreground'
            }
          />
          <span className="font-medium truncate">{step.title}</span>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
          {isRunning ? (
            <span className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
              <Loader2 size={11} className="animate-spin" /> 推理中
            </span>
          ) : (
            <span className="text-muted-foreground">已整理</span>
          )}

          {onInspectRaw && (
            <button
              type="button"
              aria-label="查看原始数据"
              onClick={(e) => {
                e.stopPropagation()
                onInspectRaw(step)
              }}
              className="rounded p-1 hover:bg-secondary hover:text-foreground text-muted-foreground"
            >
              <Code size={13} />
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/40 px-3.5 py-2.5 text-xs text-muted-foreground space-y-2.5">
          {step.thinkingText && (
            <div className="rounded border border-border/50 bg-background/80 p-2.5 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
              {step.thinkingText}
              {isRunning && isStreaming && (
                <span className="inline-block h-3.5 w-1 ml-0.5 bg-indigo-500 animate-pulse align-middle" />
              )}
            </div>
          )}

          {step.planSteps && step.planSteps.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[11px] font-medium text-foreground">计划步骤：</div>
              <ol className="space-y-1 pl-1">
                {step.planSteps.map((item) => (
                  <li key={item.index} className="flex items-center gap-2 text-[12px]">
                    <span
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[9px] ${
                        item.done
                          ? 'bg-emerald-500 text-white'
                          : 'border border-border text-muted-foreground'
                      }`}
                    >
                      {item.done && <Check size={10} />}
                    </span>
                    <span className={item.done ? 'text-muted-foreground' : 'text-foreground'}>
                      {item.index}. {item.description}
                    </span>
                    {item.capability && (
                      <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {item.capability}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
