import React, { useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Code,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  XCircle
} from 'lucide-react'
import type { VerificationStepView } from '../types'

export interface VerificationStepCardProps {
  step: VerificationStepView
  onInspectRaw?: (step: VerificationStepView) => void
}

export const VerificationStepCard: React.FC<VerificationStepCardProps> = ({
  step,
  onInspectRaw
}) => {
  const isFailed = step.status === 'failed'
  const [expanded, setExpanded] = useState<boolean>(isFailed)

  return (
    <div
      className={`rounded-lg border transition-all duration-200 ${
        isFailed
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-border/40 bg-muted/20 hover:bg-muted/30'
      }`}
      role="region"
      aria-label={step.title}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors"
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
        <div className="flex items-center gap-2 min-w-0 pr-2">
          <div className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
            {isFailed ? (
              <ShieldAlert size={14} className="text-destructive" />
            ) : step.status === 'success' ? (
              <ShieldCheck size={14} className="text-emerald-500" />
            ) : (
              <ShieldQuestion size={14} />
            )}
          </div>

          <span className="font-semibold text-foreground truncate">{step.title}</span>

          {step.passedCount !== undefined && step.totalChecks !== undefined && (
            <span className="rounded bg-secondary/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {step.passedCount}/{step.totalChecks} 通过
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs shrink-0">
          {step.status === 'success' ? (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium text-[11px]">
              <CheckCircle2 size={12} /> 验收合格
            </span>
          ) : isFailed ? (
            <span className="flex items-center gap-1 text-destructive font-medium text-[11px]">
              <AlertCircle size={12} /> 未达标
            </span>
          ) : (
            <span className="text-muted-foreground text-[11px]">校验中</span>
          )}

          {onInspectRaw && (
            <button
              type="button"
              aria-label="查看原始数据"
              onClick={(e) => {
                e.stopPropagation()
                onInspectRaw(step)
              }}
              className="rounded p-1 hover:bg-secondary hover:text-foreground text-muted-foreground transition-colors"
            >
              <Code size={12} />
            </button>
          )}

          <ChevronRight
            size={14}
            className={`text-muted-foreground transition-transform duration-200 ${
              expanded ? 'rotate-90' : ''
            }`}
          />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/40 px-3.5 py-2.5 text-xs space-y-2">
          {step.reason && (
            <p className="font-medium text-foreground text-[12px] m-0">{step.reason}</p>
          )}

          {step.checks && step.checks.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[11px] font-medium text-muted-foreground">检查项细则：</div>
              <ul className="space-y-1.5 pl-0.5">
                {step.checks.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 text-[11px]">
                    {c.ok ? (
                      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white">
                        <Check size={9} />
                      </span>
                    ) : (
                      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-destructive text-white">
                        <XCircle size={9} />
                      </span>
                    )}
                    <span className={c.ok ? 'text-foreground' : 'text-destructive font-medium'}>
                      {c.name}
                    </span>
                    {c.message && <span className="text-muted-foreground">（{c.message}）</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
