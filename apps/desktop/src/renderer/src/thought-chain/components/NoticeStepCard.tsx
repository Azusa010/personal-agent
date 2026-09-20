import React from 'react'
import { AlertTriangle, Bell, Clock, Info, Shield } from 'lucide-react'
import type { NoticeStepView } from '../types'

export interface NoticeStepCardProps {
  step: NoticeStepView
}

export const NoticeStepCard: React.FC<NoticeStepCardProps> = ({ step }) => {
  const getIcon = (): React.JSX.Element => {
    switch (step.noticeKind) {
      case 'reminder':
        return <Bell size={12} className="text-amber-500" />
      case 'budget':
        return <AlertTriangle size={12} className="text-destructive" />
      case 'permission':
        return <Shield size={12} className="text-indigo-500" />
      default:
        return <Info size={12} className="text-muted-foreground" />
    }
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-border/50 bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="shrink-0">{getIcon()}</span>
        <span className="font-medium text-foreground">{step.title}</span>
        {step.description && <span className="truncate max-w-sm">{step.description}</span>}
      </div>

      {step.startedAt && (
        <span className="font-mono text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock size={10} />
          {new Date(step.startedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  )
}
