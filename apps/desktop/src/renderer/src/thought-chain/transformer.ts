import type { PlanRecord, TaskTimeline } from '../../../shared/ipc-contract'
import type { LiveStreamState } from '../view-model'
import type {
  NoticeStepView,
  ThoughtChainStep,
  ThoughtPlanItem,
  ThoughtStepView,
  ToolStepView,
  TraceSummaryStats,
  VerificationCheckItem,
  VerificationStepView
} from './types'

function asRecord(val: unknown): Record<string, unknown> {
  return typeof val === 'object' && val !== null ? (val as Record<string, unknown>) : {}
}

function calcDuration(startIso?: string, endIso?: string): number | undefined {
  if (!startIso || !endIso) return undefined
  const start = new Date(startIso).getTime()
  const end = new Date(endIso).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined
  return end - start
}

/**
 * 将 PlanRecord 转换为思考计划 Checklist
 */
export function buildPlanItems(plan: PlanRecord | null, isTaskDone: boolean): ThoughtPlanItem[] {
  if (!plan || !Array.isArray(plan.steps)) return []
  return plan.steps.map((step, index) => ({
    index: index + 1,
    description: step.description,
    capability: step.capability ?? null,
    done: isTaskDone
  }))
}

/**
 * 将事件流（不管是历史 ExecutionEventRecord 还是流式 RunTaskEvent）
 * 规约配对为结构化的可视化 Step 数组。
 */
export function eventsToSteps(
  events: Array<{ type: string; payload: unknown; occurredAt: string }>
): ThoughtChainStep[] {
  const steps: ThoughtChainStep[] = []
  // 用于配对工具调用的 Map：callId -> ToolStepView
  const pendingToolsByCallId = new Map<string, ToolStepView>()
  const pendingToolsByCap: ToolStepView[] = []

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!ev) continue
    const payload = asRecord(ev.payload)

    switch (ev.type) {
      case 'tool_called': {
        const callId = typeof payload['callId'] === 'string' ? payload['callId'] : `call-${i}`
        const capability =
          typeof payload['capability'] === 'string' ? payload['capability'] : 'unknown_tool'
        const rawArgs = payload['arguments']
        const args =
          typeof rawArgs === 'object' && rawArgs !== null
            ? (rawArgs as Record<string, unknown>)
            : {}

        const toolStep: ToolStepView = {
          id: callId,
          type: 'tool',
          callId,
          capability,
          title: `调用工具: ${capability}`,
          status: 'running',
          startedAt: ev.occurredAt,
          arguments: args,
          rawPayload: ev.payload
        }

        steps.push(toolStep)
        pendingToolsByCallId.set(callId, toolStep)
        pendingToolsByCap.push(toolStep)
        break
      }

      case 'tool_result': {
        const callId = typeof payload['callId'] === 'string' ? payload['callId'] : null
        const capability = typeof payload['capability'] === 'string' ? payload['capability'] : null
        const ok = payload['ok'] === true

        // 优先按 callId 配对，其次按最近同 capability 逆向配对
        let targetTool: ToolStepView | undefined
        if (callId && pendingToolsByCallId.has(callId)) {
          targetTool = pendingToolsByCallId.get(callId)
          pendingToolsByCallId.delete(callId)
        } else if (capability) {
          const idx = pendingToolsByCap.findIndex((t) => t.capability === capability)
          if (idx !== -1) {
            targetTool = pendingToolsByCap.splice(idx, 1)[0]
          }
        }

        if (targetTool) {
          targetTool.endedAt = ev.occurredAt
          targetTool.durationMs = calcDuration(targetTool.startedAt, ev.occurredAt)
          targetTool.status = ok ? 'success' : 'failed'
          targetTool.observation = payload['result'] ?? payload['output']

          if (!ok) {
            const errObj = asRecord(payload['error'])
            targetTool.error = {
              code: typeof errObj['code'] === 'string' ? errObj['code'] : undefined,
              message:
                typeof errObj['message'] === 'string'
                  ? errObj['message']
                  : typeof payload['reason'] === 'string'
                    ? payload['reason']
                    : '工具执行失败',
              stack: typeof errObj['stack'] === 'string' ? errObj['stack'] : undefined
            }
          }
        } else {
          // 孤儿 tool_result：单独生成一个完成态卡片
          steps.push({
            id: `result-${i}`,
            type: 'tool',
            callId: callId ?? `orphan-${i}`,
            capability: capability ?? 'unknown_tool',
            title: `工具返回: ${capability ?? 'unknown_tool'}`,
            status: ok ? 'success' : 'failed',
            endedAt: ev.occurredAt,
            arguments: {},
            observation: payload['result'],
            rawPayload: ev.payload
          })
        }
        break
      }

      case 'verification_started':
      case 'verification_passed':
      case 'verification_failed': {
        const isEnded = ev.type !== 'verification_started'
        const isPassed = ev.type === 'verification_passed'
        const report = asRecord(payload['report'])
        const rawChecks = Array.isArray(report['checks']) ? report['checks'] : []

        const checks: VerificationCheckItem[] = rawChecks.map((item, idx) => {
          const c = asRecord(item)
          return {
            name: typeof c['name'] === 'string' ? c['name'] : `检查点 ${idx + 1}`,
            ok: c['ok'] === true,
            message: typeof c['message'] === 'string' ? c['message'] : undefined
          }
        })

        const passedCount = checks.filter((c) => c.ok).length
        const totalChecks = checks.length
        const reason = typeof report['reason'] === 'string' ? report['reason'] : undefined
        const factCount =
          typeof payload['factCount'] === 'number' ? payload['factCount'] : undefined

        const verStep: VerificationStepView = {
          id: `verify-${i}`,
          type: 'verification',
          title: isEnded ? (isPassed ? '交付物校验通过' : '交付物校验未通过') : '开始校验交付物',
          status: isEnded ? (isPassed ? 'success' : 'failed') : 'running',
          startedAt: ev.occurredAt,
          factCount,
          passedCount,
          totalChecks,
          reason,
          checks,
          rawPayload: ev.payload
        }
        steps.push(verStep)
        break
      }

      case 'reminder_created': {
        const remindAt = typeof payload['remindAt'] === 'string' ? payload['remindAt'] : ''
        const message = typeof payload['message'] === 'string' ? payload['message'] : ''
        const notice: NoticeStepView = {
          id: `reminder-${i}`,
          type: 'notice',
          noticeKind: 'reminder',
          title: '已创建提醒',
          status: 'success',
          startedAt: ev.occurredAt,
          description: remindAt ? `提醒时间：${remindAt} · ${message}` : message,
          rawPayload: ev.payload
        }
        steps.push(notice)
        break
      }

      case 'budget_exhausted': {
        const stepsCount = payload['steps']
        const toolCalls = payload['toolCalls']
        const notice: NoticeStepView = {
          id: `budget-${i}`,
          type: 'notice',
          noticeKind: 'budget',
          title: '预算耗尽',
          status: 'failed',
          startedAt: ev.occurredAt,
          description: `已达上限：${stepsCount ?? '?'} 步 / ${toolCalls ?? '?'} 次工具调用`,
          rawPayload: ev.payload
        }
        steps.push(notice)
        break
      }

      case 'permission_requested':
      case 'permission_decision':
      case 'permission_expired': {
        const cap = typeof payload['capability'] === 'string' ? payload['capability'] : ''
        const decision = typeof payload['decision'] === 'string' ? payload['decision'] : ''
        let desc = ''
        if (ev.type === 'permission_requested') {
          desc = `请求使用 ${cap}`
        } else if (ev.type === 'permission_decision') {
          desc = `权限决定：${decision === 'approved' ? '已批准' : '已拒绝'}`
        } else {
          desc = '权限审批超时'
        }

        const notice: NoticeStepView = {
          id: `perm-${i}`,
          type: 'notice',
          noticeKind: 'permission',
          title: '权限事件',
          status: ev.type === 'permission_expired' || decision === 'denied' ? 'failed' : 'success',
          startedAt: ev.occurredAt,
          description: desc,
          rawPayload: ev.payload
        }
        steps.push(notice)
        break
      }

      default:
        break
    }
  }

  return steps
}

/**
 * 将完整的历史 TaskTimeline 转换为结构化步骤
 */
export function timelineToSteps(
  timeline: TaskTimeline | null,
  cachedThinking?: string
): ThoughtChainStep[] {
  if (!timeline) return []

  const isCompleted = timeline.task.status === 'completed'
  const planItems = buildPlanItems(timeline.plan, isCompleted)
  const steps: ThoughtChainStep[] = []
  const hasThinking = typeof cachedThinking === 'string' && cachedThinking.trim().length > 0

  // 如果有计划或缓存了思维链，作为第一步思考与规划卡片
  if (planItems.length > 0 || hasThinking) {
    const thoughtStep: ThoughtStepView = {
      id: `plan-${timeline.task.id}`,
      type: 'thought',
      title: hasThinking ? '推理过程与执行计划' : '制定执行计划与策略',
      status: isCompleted ? 'success' : timeline.task.status === 'failed' ? 'failed' : 'running',
      thinkingText: hasThinking
        ? cachedThinking
        : `为目标「${timeline.task.goal}」拆解的执行步骤：`,
      planSteps: planItems.length > 0 ? planItems : undefined,
      startedAt: timeline.task.createdAt
    }
    steps.push(thoughtStep)
  }

  const eventSteps = eventsToSteps(timeline.events)
  steps.push(...eventSteps)
  return steps
}

/**
 * 将流式 LiveStreamState 转换为实时步骤列表
 */
export function streamStateToSteps(state: LiveStreamState | null): ThoughtChainStep[] {
  if (!state) return []
  const steps: ThoughtChainStep[] = []

  // 如果有思考内容，作为实时思考卡片
  if (state.thinking && state.thinking.trim().length > 0) {
    steps.push({
      id: `live-thinking-${state.taskId ?? 'current'}`,
      type: 'thought',
      title: '正在深度思考与推理...',
      status: 'running',
      thinkingText: state.thinking
    })
  }

  // 转换流式事件
  if (state.events && state.events.length > 0) {
    const eventSteps = eventsToSteps(state.events)
    steps.push(...eventSteps)
  }

  return steps
}

/**
 * 计算轨迹统计概览指标
 */
export function calculateTraceStats(steps: ThoughtChainStep[]): TraceSummaryStats {
  const totalSteps = steps.length
  const toolCallsCount = steps.filter((s) => s.type === 'tool').length
  const hasErrors = steps.some((s) => s.status === 'failed')

  let totalDurationMs = 0
  for (const s of steps) {
    if (s.durationMs !== undefined && s.durationMs > 0) {
      totalDurationMs += s.durationMs
    }
  }

  return {
    totalSteps,
    toolCallsCount,
    totalDurationMs: totalDurationMs > 0 ? totalDurationMs : undefined,
    hasErrors
  }
}
