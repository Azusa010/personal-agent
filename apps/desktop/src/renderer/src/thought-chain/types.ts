export type StepType = 'thought' | 'tool' | 'verification' | 'notice'
export type StepStatus = 'pending' | 'running' | 'success' | 'failed'

export interface BaseStepView {
  id: string
  type: StepType
  title: string
  status: StepStatus
  startedAt?: string
  endedAt?: string
  durationMs?: number
  rawPayload?: unknown
}

export interface ThoughtPlanItem {
  index: number
  description: string
  capability: string | null
  done?: boolean
}

export interface ThoughtStepView extends BaseStepView {
  type: 'thought'
  thinkingText: string
  planSteps?: ThoughtPlanItem[]
}

export interface ToolStepView extends BaseStepView {
  type: 'tool'
  callId: string
  capability: string
  arguments: Record<string, unknown>
  observation?: unknown
  error?: {
    code?: string
    message: string
    stack?: string
  }
}

export interface VerificationCheckItem {
  name: string
  ok: boolean
  message?: string
}

export interface VerificationStepView extends BaseStepView {
  type: 'verification'
  factCount?: number
  passedCount?: number
  totalChecks?: number
  reason?: string
  checks?: VerificationCheckItem[]
}

export interface NoticeStepView extends BaseStepView {
  type: 'notice'
  noticeKind: 'permission' | 'reminder' | 'budget' | 'generic'
  description: string
}

export type ThoughtChainStep =
  ThoughtStepView | ToolStepView | VerificationStepView | NoticeStepView

export type StepFilter = 'all' | 'thought' | 'tool' | 'verification' | 'error'

export interface TraceSummaryStats {
  totalSteps: number
  toolCallsCount: number
  totalDurationMs?: number
  hasErrors: boolean
}
