import React, { useState } from 'react'
import { ChevronRight, Code } from 'lucide-react'
import type { ThoughtStepView } from '../types'
import { TextShimmer } from './TextShimmer'

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

  const formattedDuration =
    step.durationMs !== undefined
      ? step.durationMs >= 1000
        ? `${(step.durationMs / 1000).toFixed(1)}s`
        : `${step.durationMs}ms`
      : null

  const label = isRunning ? (
    <TextShimmer duration={1.2} className="text-xs font-[450]">
      {step.title.includes('思考') || step.title.includes('Thinking') ? step.title : 'Thinking'}
    </TextShimmer>
  ) : (
    <span className="text-xs font-[450]">
      Thought {formattedDuration ? `· ${formattedDuration}` : ''}
    </span>
  )

  return (
    <div className="flex flex-col gap-1 w-full my-0.5" role="region" aria-label={step.title}>
      {/* 官方 agent-elements 风格的 ToolRowBase / Thinking 行 */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 max-w-full select-none cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5 group"
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
        {label}

        <ChevronRight
          size={12}
          className={`shrink-0 text-muted-foreground transition-transform duration-150 ease-out ${
            expanded ? 'rotate-90' : 'rotate-0'
          }`}
        />

        {onInspectRaw && (
          <button
            type="button"
            aria-label="查看原始数据"
            onClick={(e) => {
              e.stopPropagation()
              onInspectRaw(step)
            }}
            className="ml-auto opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground transition-opacity"
          >
            <Code size={12} />
          </button>
        )}
      </div>

      {/* 官方展开样式：无厚重方框，仅左侧细线与轻微缩进 */}
      {expanded && (
        <div className="pl-3.5 ml-1 border-l border-border/50 py-1 max-h-[220px] overflow-y-auto space-y-2">
          {step.thinkingText && (
            <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed m-0 font-sans select-text">
              {step.thinkingText}
              {isRunning && isStreaming && (
                <span className="inline-block h-3 w-0.5 ml-0.5 bg-foreground/60 animate-pulse align-middle" />
              )}
            </p>
          )}

          {step.planSteps && step.planSteps.length > 0 && (
            <div className="space-y-1 pt-1">
              <div className="text-[11px] font-medium text-foreground/80">计划步骤：</div>
              <ol className="space-y-1 pl-1">
                {step.planSteps.map((item) => (
                  <li key={item.index} className="flex items-center gap-1.5 text-[11px]">
                    <span
                      className={
                        item.done ? 'text-emerald-500 font-bold' : 'text-muted-foreground/50'
                      }
                    >
                      {item.done ? '✓' : '○'}
                    </span>
                    <span
                      className={
                        item.done ? 'text-muted-foreground/70 line-through' : 'text-foreground/90'
                      }
                    >
                      {item.index}. {item.description}
                    </span>
                    {item.capability && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono">
                        ({item.capability})
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
