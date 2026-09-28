import React from 'react'
import { AlertTriangle, Bell, Clock, Info, Shield } from 'lucide-react'
import type { NoticeStepView } from '../types'

export interface NoticeStepCardProps {
  step: NoticeStepView
}

export const NoticeStepCard: React.FC<NoticeStepCardProps> = ({ step }) => {
  const [resetState, setResetState] = React.useState<'idle' | 'resetting' | 'done'>('idle')
  const [feedback, setFeedback] = React.useState<string | null>(null)

  const raw = step.rawPayload as Record<string, unknown> | undefined
  const taskId = typeof raw?.['taskId'] === 'string' ? raw['taskId'] : undefined

  const handleReset = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!taskId || resetState === 'resetting') return
    setResetState('resetting')
    try {
      const res = await window.personalAgent.resetCircuitBreaker(
        taskId,
        '用户在前端思维链卡片人工确认恢复试探'
      )
      if (res.ok) {
        setResetState('done')
        setFeedback('已恢复半开试探')
      } else {
        setResetState('idle')
        setFeedback(res.message || '恢复失败')
      }
    } catch {
      setResetState('idle')
      setFeedback('恢复请求失败')
    }
  }

  const getIcon = (): React.JSX.Element => {
    switch (step.noticeKind) {
      case 'reminder':
        return <Bell size={12} className="text-amber-500" />
      case 'budget':
        return <AlertTriangle size={12} className="text-destructive" />
      case 'permission':
        return <Shield size={12} className="text-indigo-500" />
      case 'sidecar':
        return step.status === 'success' ? (
          <Shield size={12} className="text-emerald-500" />
        ) : (
          <Shield size={12} className="text-amber-500" />
        )
      case 'circuit_breaker':
        return <AlertTriangle size={12} className="text-destructive" />
      default:
        return <Info size={12} className="text-muted-foreground" />
    }
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="shrink-0">{getIcon()}</span>
        <span className="font-medium text-foreground">{step.title}</span>
        {step.description && <span className="truncate max-w-sm">{step.description}</span>}
      </div>

      <div className="flex items-center gap-2">
        {step.noticeKind === 'circuit_breaker' && (
          <div className="flex items-center gap-1.5">
            {feedback && <span className="text-[10px] text-muted-foreground">{feedback}</span>}
            {taskId && resetState !== 'done' && (
              <button
                type="button"
                onClick={handleReset}
                disabled={resetState === 'resetting'}
                className="rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
              >
                {resetState === 'resetting' ? '恢复中...' : '解除熔断 (半开试探)'}
              </button>
            )}
            {resetState === 'done' && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                已就绪 (HALF_OPEN)
              </span>
            )}
          </div>
        )}

        {step.startedAt && (
          <span className="font-mono text-[10px] text-muted-foreground flex items-center gap-1">
            <Clock size={10} />
            {new Date(step.startedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  )
}
