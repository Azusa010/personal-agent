import React, { useMemo, useState } from 'react'
import type { TaskTimeline } from '../../../../shared/ipc-contract'
import type { LiveStreamState } from '../../view-model'
import { streamStateToSteps, timelineToSteps } from '../transformer'
import type { ThoughtChainStep, ToolStepView } from '../types'
import { NoticeStepCard } from './NoticeStepCard'
import { RawSpanDialog } from './RawSpanDialog'
import { SubagentStepCard } from './SubagentStepCard'
import { ThoughtStepCard } from './ThoughtStepCard'
import { ToolStepCard } from './ToolStepCard'

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
  const [inspectStep, setInspectStep] = useState<ThoughtChainStep | null>(null)

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

  if (steps.length === 0) {
    return null
  }

  return (
    <div className={`space-y-1 text-left ${className}`}>
      {/* 步骤卡片流 */}
      <div className="space-y-2">
        {steps.map((step) => {
          if (step.type === 'thought') {
            return (
              <ThoughtStepCard
                key={step.id}
                step={step}
                isStreaming={isStreaming}
                onInspectRaw={(s) => setInspectStep(s)}
              />
            )
          }
          if (step.type === 'tool') {
            if (step.capability === 'spawn_subagent') {
              return (
                <SubagentStepCard
                  key={step.id}
                  step={step}
                  isStreaming={isStreaming}
                  onInspectRaw={(s) => setInspectStep(s)}
                />
              )
            }
            return (
              <ToolStepCard
                key={step.id}
                step={step}
                isStreaming={isStreaming}
                onRetry={onRetryStep}
                onInspectRaw={(s) => setInspectStep(s)}
              />
            )
          }
          if (step.type === 'verification') {
            return null
          }
          if (step.type === 'notice') {
            if (step.noticeKind === 'permission' || step.noticeKind === 'sidecar') return null
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
