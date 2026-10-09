import React, { useState, useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { AlertTriangle, Bell, ChevronRight, Clock, Info, Shield } from 'lucide-react'
import type { NoticeStepView } from '../types'

export interface NoticeStepCardProps {
  step: NoticeStepView
}

export const NoticeStepCard: React.FC<NoticeStepCardProps> = ({ step }) => {
  const [resetState, setResetState] = React.useState<'idle' | 'resetting' | 'done'>('idle')
  const [feedback, setFeedback] = React.useState<string | null>(null)

  const drawerRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [expanded, setExpanded] = useState<boolean>(false)

  const raw = step.rawPayload as Record<string, unknown> | undefined
  const taskId = typeof raw?.['taskId'] === 'string' ? raw['taskId'] : undefined

  useGSAP(() => {
    if (expanded) {
      gsap.fromTo(
        drawerRef.current,
        { height: 0, opacity: 0, scaleY: 0.95 },
        {
          height: 'auto',
          opacity: 1,
          scaleY: 1,
          duration: 0.5,
          ease: 'back.out(1.2)',
          transformOrigin: 'top center'
        }
      )
    } else if (drawerRef.current) {
      gsap.to(drawerRef.current, {
        height: 0,
        opacity: 0,
        scaleY: 0.95,
        duration: 0.3,
        ease: 'power2.in'
      })
    }
  }, [expanded])

  useGSAP(() => {
    if (hovered || expanded) {
      gsap.to(pillRef.current, {
        width: 'auto',
        paddingRight: '10px',
        duration: 0.3,
        ease: 'power2.out'
      })
    } else {
      gsap.to(pillRef.current, {
        width: '28px',
        paddingRight: '0px',
        duration: 0.3,
        ease: 'power2.inOut'
      })
    }
  }, [hovered, expanded])

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
      case 'circuit_breaker':
        return <AlertTriangle size={12} className="text-destructive" />
      case 'permission':
        return <Shield size={12} className="text-indigo-500" />
      case 'sidecar':
        return step.status === 'success' ? (
          <Shield size={12} className="text-emerald-500" />
        ) : (
          <Shield size={12} className="text-amber-500" />
        )
      default:
        return <Info size={12} className="text-primary" />
    }
  }

  return (
    <div
      className="flex flex-col gap-1 w-fit max-w-full my-0.5 group"
      role="region"
      aria-label={step.title}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="flex items-center gap-2 max-w-full select-none cursor-pointer text-xs transition-colors py-1 group"
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
        <div
          ref={pillRef}
          className="overflow-hidden whitespace-nowrap flex items-center bg-[#27272a]/50 backdrop-blur-sm shadow-[0_0_8px_rgba(16,163,127,0.15)] border border-[rgba(16,163,127,0.3)] text-[11px] px-1.5 py-1 rounded-full text-[#fafafa] flex-shrink-0"
          style={{ width: 'auto' }}
        >
          <span className="w-4 h-4 flex items-center justify-center shrink-0">{getIcon()}</span>
          <span className="ml-1.5 font-medium">{step.title}</span>
        </div>

        {!expanded && !hovered && (
          <span className="text-[11px] text-muted-foreground/50 ml-1 truncate max-w-xs">
            {step.title}
          </span>
        )}

        <div className="flex items-center gap-1 ml-auto shrink-0 text-[11px] font-mono text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
          {step.startedAt && (
            <span className="flex items-center gap-1 mr-1">
              <Clock size={10} />
              {new Date(step.startedAt).toLocaleTimeString()}
            </span>
          )}
          <ChevronRight
            size={12}
            className={`shrink-0 text-muted-foreground transition-transform duration-150 ease-out ${
              expanded ? 'rotate-90' : 'rotate-0'
            }`}
          />
        </div>
      </div>

      <div
        ref={drawerRef}
        className="overflow-hidden"
        style={{ height: expanded ? 'auto' : 0, opacity: expanded ? 1 : 0 }}
      >
        <div className="mt-2 p-3 bg-[#27272a]/50 backdrop-blur-sm rounded-xl border border-border/50 max-h-[300px] overflow-y-auto space-y-3 text-xs">
          {step.description && (
            <p className="font-medium text-foreground/90 text-[11px] m-0 leading-relaxed whitespace-pre-wrap">
              {step.description}
            </p>
          )}

          {step.noticeKind === 'circuit_breaker' && (
            <div className="flex items-center gap-2 pt-1 border-t border-border/30">
              {feedback && <span className="text-[10px] text-muted-foreground/80">{feedback}</span>}
              {taskId && resetState !== 'done' && (
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={resetState === 'resetting'}
                  className="rounded bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-500 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                >
                  {resetState === 'resetting' ? '恢复中...' : '解除熔断 (半开试探)'}
                </button>
              )}
              {resetState === 'done' && (
                <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
                  已就绪 (HALF_OPEN)
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
