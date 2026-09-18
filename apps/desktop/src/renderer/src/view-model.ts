import { RunTaskEvent } from '@personal-agent/protocol'
import type {
  ExecutionEventRecord,
  PlanRecord,
  PermissionViewState,
  RunTaskIpcResult,
  SummaryFact,
  TaskStatus,
  TaskTimeline,
  AgentStreamNotice
} from '../../shared/ipc-contract'

// ---- 一、跑任务结果的三态文案 ----

/** success = 任务跑完了；failed = 任务跑完了但结局是失败；error = 这次调用本身没成 */
export type OutcomeTone = 'success' | 'failed' | 'error'

export interface RunOutcomeView {
  tone: OutcomeTone
  headline: string
  /** 补充信息，没有就是 null。UI 见到 null 不渲染这一行，不渲染空行 */
  detail: string | null
  facts: SummaryFact[]
  /** error 态拿不到 taskId：调用没成，库里可能压根没有这一行 */
  taskId: string | null
}

export function describeRunOutcome(result: RunTaskIpcResult): RunOutcomeView {
  if (!result.ok) {
    return {
      tone: 'error',
      headline: '这次调用没跑起来',
      detail: `[${result.code}] ${result.message}`,
      facts: [],
      taskId: null
    }
  }
  if (result.status === 'completed') {
    return {
      tone: 'success',
      headline: '任务完成',
      detail: null,
      facts: result.facts ?? [],
      taskId: result.taskId
    }
  }
  return {
    tone: 'failed',
    headline: '任务失败',
    detail: result.reason ?? null,
    facts: [],
    taskId: result.taskId
  }
}

// ---- 二、事件类型标签 ----

// 前六个类型来自 engine.py 的 EVENT_* 常量，后三个来自 permission-broker 的 PERMISSION_EVENT。
// 这里故意用 Record<string, string>
// 而不是把键收窄成联合：库里可能躺着旧版本写入的行，遇到没登记的 type 时
// describeEvent 原样显示英文 type，比崩掉或者显示空白都好。
export const EVENT_LABELS: Readonly<Record<string, string>> = {
  task_started: '任务开始',
  tool_called: '调用工具',
  tool_result: '工具返回',
  budget_exhausted: '预算耗尽',
  task_completed: '任务完成',
  task_failed: '任务失败',
  permission_requested: '请求批准',
  permission_decision: '批准结论',
  permission_expired: '批准超时',
  reminder_created: '创建提醒',
  // TASK-026：completed 只由校验结论触发，这三条是闸口的开合记录
  verification_started: '开始校验交付物',
  verification_passed: '交付物校验通过',
  verification_failed: '交付物校验未通过'
}

// ---- 三、任务状态标签 ----

// Record<TaskStatus, string> 是穷举的：将来状态机加一种，这里不加就编译不过。
export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  pending: '排队中',
  running: '执行中',
  waiting_permission: '等你批准',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消'
}

export const PERMISSION_STATE_LABELS: Readonly<Record<PermissionViewState, string>> = {
  pending: '等待决定',
  approved: '已批准',
  denied: '已拒绝',
  expired: '已过期'
}

// ---- 四、时间格式化 ----

export function formatOccurredAt(iso: string): string {
  const date = new Date(iso)
  // occurredAt 在库里是 TEXT，没有 CHECK 约束。脏数据不该让整条时间线渲染失败，
  // 原样显示比 'NaN-NaN-NaN' 有用。
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function formatRemaining(expiresAt: string, now: number): string {
  const expires = Date.parse(expiresAt)
  if (Number.isNaN(expires) || !Number.isFinite(expires)) {
    return ''
  }
  const remaining = expires - now
  if (remaining <= 0) {
    return '00:00'
  }
  return remaining > 0
    ? `${String(Math.floor(remaining / 60000)).padStart(2, '0')}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}`
    : ''
}

// ---- 五、事件行 ----

export interface EventLineView {
  seq: number
  /** 原始 type 留着：调试时要知道中文标签是从哪个 type 映射来的 */
  type: string
  label: string
  summary: string
  time: string
}

export function describeEvent(event: ExecutionEventRecord): EventLineView {
  return {
    seq: event.seq,
    type: event.type,
    label: EVENT_LABELS[event.type] ?? event.type,
    summary: summarizePayload(event.type, event.payload),
    time: formatOccurredAt(event.occurredAt)
  }
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function num(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function json(value: unknown): string | null {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : text
  } catch {
    return null
  }
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
}

function join(parts: Array<string | null>): string {
  return oneLine(parts.filter((p): p is string => p !== null).join(' · '))
}

function fallback(payload: unknown): string {
  if (typeof payload === 'string') return oneLine(payload)
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload)
  const text = json(payload)
  if (text === null || text === '{}' || text === '[]' || text === 'null') return '（无内容）'
  return oneLine(text)
}

export function summarizePayload(type: string, payload: unknown): string {
  const record = asRecord(payload)

  switch (type) {
    case 'task_started': {
      const goal = str(record['goal'])
      return goal === null ? fallback(payload) : oneLine(goal)
    }
    case 'tool_called': {
      const args = json(record['arguments'])
      return join([
        str(record['callId']),
        str(record['capability']) ?? '未知能力',
        args === null ? null : oneLine(args)
      ])
    }
    case 'tool_result': {
      const ok = record['ok']
      const verdict = ok === true ? '成功' : ok === false ? '失败' : '结果未知'
      return join([str(record['capability']) ?? '未知能力', verdict])
    }
    case 'budget_exhausted': {
      return `已用 ${num(record['steps']) ?? '?'} 步 / ${num(record['toolCalls']) ?? '?'} 次工具调用`
    }
    case 'task_completed': {
      const count = num(record['factCount'])
      return count === null ? fallback(payload) : `产出 ${count} 条摘要`
    }
    case 'task_failed': {
      const reason = str(record['reason'])
      if (reason !== null) return oneLine(reason)
      const code = str(record['code'])
      const message = str(record['message'])
      if (code !== null || message !== null) return join([code, message])
      return fallback(payload)
    }
    case 'permission_requested': {
      const capability = str(record['capability']) ?? '未知能力'
      const targetPath = str(record['targetPath'])
      const rawSourcePaths = record['sourcePaths']
      const sourcePaths = Array.isArray(rawSourcePaths)
        ? rawSourcePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : []
      let msg = `使用 ${capability} 访问`
      if (targetPath !== null) {
        msg += `目标路径：${targetPath}`
      } else if (sourcePaths.length > 0) {
        msg += `源路径：${join(sourcePaths)}`
      } else {
        msg += fallback(payload)
      }
      return oneLine(msg)
    }
    case 'permission_decision': {
      const decision = str(record['decision'])
      if (decision === null) return fallback(payload)
      const label = (PERMISSION_STATE_LABELS as Readonly<Record<string, string>>)[decision]
      return label ?? oneLine(decision)
    }
    case 'permission_expired': {
      return '批准窗口内没有响应'
    }
    case 'reminder_created': {
      // TASK-023 的 reminder_created 事件：时间用本地格式渲染，
      // 「今晚八点」解析成了哪个具体时刻要一眼能看出来。
      const remindAt = str(record['remindAt'])
      const message = str(record['message'])
      const parts: Array<string | null> = [
        remindAt === null ? null : `提醒时间：${formatOccurredAt(remindAt)}`,
        message
      ]
      return parts.every((p) => p === null) ? fallback(payload) : join(parts)
    }
    case 'verification_started': {
      const count = num(record['factCount'])
      return count === null ? '开始校验交付物' : `待校验 ${count} 条摘要`
    }
    case 'verification_passed':
    case 'verification_failed': {
      // payload = { report, evidence }。行内只报「通过几项 / 为什么没通过」，
      // 完整证据包留给诊断面板——时间线一行塞不下一个 Evidence Bundle。
      const report = asRecord(record['report'])
      const rawChecks = report['checks']
      const checks = Array.isArray(rawChecks) ? rawChecks : []
      const passed = checks.filter((c) => asRecord(c)['ok'] === true).length
      const tally = checks.length === 0 ? null : `通过 ${passed}/${checks.length} 项检查`
      const combined = join([str(report['reason']), tally])
      return combined === '' ? fallback(payload) : combined
    }
    default:
      return fallback(payload)
  }
}

// ---- 五点五、scheduler.create 的时间预览 ----

/** 批准面板的时间预览数据源：从 argsCanonical 解析出规范化参数。
 *
 *  只对 scheduler.create 生效；argsCanonical 不是合法 JSON 或缺 remindAt 时
 *  返回 null，Dialog 退回通用展示（参数摘要行仍会原样展示 argsCanonical）。
 *  message 单独判：缺了它时间预览仍然有意义。 */
export function describeReminderPreview(permission: {
  capability: string
  argsCanonical: string
}): { remindAt: string; message: string | null } | null {
  if (permission.capability !== 'scheduler.create') return null
  try {
    const args = JSON.parse(permission.argsCanonical) as Record<string, unknown>
    const remindAt = str(args['remindAt'])
    if (remindAt === null) return null
    return { remindAt, message: str(args['message']) }
  } catch {
    return null
  }
}

// ---- 六、计划步骤 ----

export interface PlanStepView {
  /** 1-based，UI 直接当序号显示 */
  index: number
  description: string
  /** 第三步是 null：那一步由模型自己产出，不经 host 工具 */
  capability: string | null
  capabilityLabel: string
}

export function describePlanSteps(plan: PlanRecord | null): PlanStepView[] {
  if (plan === null) return []
  return plan.steps.map((step, i) => ({
    index: i + 1,
    description: step.description,
    capability: step.capability ?? null,
    capabilityLabel: step.capability ?? '模型产出，不经工具'
  }))
}

// ---- 七、从事件流里挖摘要 ----

/**
 * 返回 null 表示根本没跑完过（没有这条事件）。
 * factCount 与 facts 两个字段各自取，取不到各自降级：库里存着改契约之前写的
 * 旧记录，那些只有 factCount 没有 facts。
 */

// 从最后一条 task_completed 的 payload 里还原摘要数量。
export function extractFactCount(events: ExecutionEventRecord[]): number | null {
  const record = lastCompletedPayload(events)
  if (record === null) return null
  const raw = record['factCount']
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/**
 * 从最后一条 task_completed 的 payload 里还原摘要正文。
 */
export function extractFacts(events: ExecutionEventRecord[]): SummaryFact[] {
  const record = lastCompletedPayload(events)
  if (record === null) return []
  const raw = record['facts']
  if (!Array.isArray(raw)) return []

  const facts: SummaryFact[] = []
  for (const item of raw) {
    const fact = asFact(item)
    // 形状不对的整条丢掉，不剔里面坏的页码：剩下半个引用列表会把
    // 「这条摘要来自第 1、3 页」渲染成「第 1 页」，看上去像真的。
    if (fact !== null) facts.push(fact)
  }
  return facts
}

export function extractReply(events: ExecutionEventRecord[]): string | null {
  const record = lastCompletedPayload(events)
  if (record === null) return null
  const raw = record['reply']
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null
}

// 倒着找：一个任务正常只有一条 task_completed，但库里可能有脏数据，
// 取最后一条才是最终结局。
function lastCompletedPayload(events: ExecutionEventRecord[]): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined || event.type !== 'task_completed') continue
    return asRecord(event.payload)
  }
  return null
}

function asFact(value: unknown): SummaryFact | null {
  const record = asRecord(value)
  const text = record['text']
  const refs = record['pageRefs']
  if (typeof text !== 'string' || text.length === 0) return null
  if (!Array.isArray(refs)) return null
  const ok = refs.every((ref) => typeof ref === 'number' && Number.isInteger(ref) && ref >= 1)
  return ok ? { text, pageRefs: refs as number[] } : null
}

// ---- 八、导出 Markdown ----

/** 「导出 Markdown」芯片的剪贴板内容：goal、状态、带页码的摘要事实与计划步骤。 */
export function timelineToMarkdown(timeline: TaskTimeline): string {
  const lines: string[] = [
    `# ${timeline.task.goal}`,
    '',
    `状态：${STATUS_LABELS[timeline.task.status]}`,
    ''
  ]
  const facts = extractFacts(timeline.events)
  if (facts.length > 0) {
    lines.push('## 摘要', '')
    for (const fact of facts) {
      const pages = fact.pageRefs.map((page) => `p.${page}`).join(', ')
      lines.push(`- ${fact.text}${pages.length > 0 ? `（${pages}）` : ''}`)
    }
    lines.push('')
  }
  const steps = describePlanSteps(timeline.plan)
  if (steps.length > 0) {
    lines.push('## 计划', '')
    for (const step of steps) {
      lines.push(`${step.index}. ${step.description}（${step.capabilityLabel}）`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// 9.实时流状态与规约
export interface LiveStreamState {
  taskId: string | null
  events: RunTaskEvent[]
  thinking: string
}
export function createInitialStreamState(): LiveStreamState {
  return { taskId: null, events: [], thinking: '' }
}

// 实时流状态规约
export function applyStreamNotice(
  state: LiveStreamState | null,
  notice: AgentStreamNotice
): LiveStreamState | null {
  if (state === null) {
    return null
  }
  if (state.taskId === null) {
    return {
      ...state,
      taskId: notice.taskId,
      thinking: notice.kind === 'thinking' ? notice.delta : '',
      events: notice.kind === 'event' ? [notice.event] : []
    }
  } else if (state.taskId !== notice.taskId) {
    return state
  }
  if (notice.kind === 'thinking') {
    return { ...state, thinking: state.thinking + notice.delta }
  } else if (notice.kind === 'event') {
    return { ...state, events: [...state.events, notice.event] }
  }
  return state
}
