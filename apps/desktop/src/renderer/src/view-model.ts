import type {
  ExecutionEventRecord,
  PlanRecord,
  RunTaskIpcResult,
  SummaryFact,
  TaskStatus
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

// 六个类型来自 engine.py 的 EVENT_* 常量。这里故意用 Record<string, string>
// 而不是把键收窄成联合：库里可能躺着旧版本写入的行，遇到没登记的 type 时
// describeEvent 原样显示英文 type，比崩掉或者显示空白都好。
export const EVENT_LABELS: Readonly<Record<string, string>> = {
  task_started: '任务开始',
  tool_called: '调用工具',
  tool_result: '工具返回',
  budget_exhausted: '预算耗尽',
  task_completed: '任务完成',
  task_failed: '任务失败'
}

// ---- 三、任务状态标签 ----

// Record<TaskStatus, string> 是穷举的：将来状态机加一种，这里不加就编译不过。
export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  pending: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消'
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
    default:
      return fallback(payload)
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

// ---- 七、从事件流里挖摘要条数 ----

/**
 * task_completed 的 payload 里只有 factCount，没有正文。
 * 返回 null 表示根本没跑完过（没有这条事件）。
 */
export function extractFactCount(events: ExecutionEventRecord[]): number | null {
  // 倒着找：一个任务正常只有一条 task_completed，但库里可能有脏数据，
  // 取最后一条才是最终结局。
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined || event.type !== 'task_completed') continue
    const raw = asRecord(event.payload)['factCount']
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  }
  return null
}
