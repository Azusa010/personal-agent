import React, { useMemo } from 'react'
import type { TaskTimeline } from '../../../../shared/ipc-contract'
import type { LiveStreamState } from '../../view-model'
import { stepsToFlowLines } from '../flow'
import { streamStateToSteps, timelineToSteps } from '../transformer'
import type { ToolStepView } from '../types'
import { StepFlow } from './StepFlow'

export interface ThoughtChainViewerProps {
  timeline?: TaskTimeline | null
  liveStream?: LiveStreamState | null
  isStreaming?: boolean
  cachedThinking?: string
  onRetryStep?: (step: ToolStepView) => void
  className?: string
}

/**
 * 执行轨迹的入口：把时间线/流式状态转成步骤，再翻成「几句人话」。
 *
 * 旧稿在这里铺一组步骤卡片（思考卡、工具卡、子代理卡、审查卡），
 * 每一张都有边框、图标和折叠头；新稿砍掉这一层容器，
 * 只留下叙述——一行一件事，工具名作为旁注淡在行尾。
 * 需要核对原始参数时，点那一行即可打开 RawSpanDialog。
 */
export const ThoughtChainViewer: React.FC<ThoughtChainViewerProps> = ({
  timeline = null,
  liveStream = null,
  cachedThinking,
  className = ''
}) => {
  const lines = useMemo(() => {
    const steps = liveStream
      ? streamStateToSteps(liveStream)
      : timeline
        ? timelineToSteps(timeline, cachedThinking)
        : []
    return stepsToFlowLines(steps)
  }, [timeline, liveStream, cachedThinking])

  if (lines.length === 0) return null

  return <StepFlow lines={lines} className={className} />
}
