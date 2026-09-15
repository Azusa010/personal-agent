export const TASK_STATUSES = [
  'pending',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled'
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 领域对象 */
export interface TaskRecord {
  id: string
  goal: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

/** 一条执行事件。payload 是 unknown：六种事件类型各有各的形状，窄化是读方的事 */
export interface ExecutionEventRecord {
  seq: number
  taskId: string
  type: string
  payload: unknown
  occurredAt: string
}

/** 计划里的一步。capability 缺失表示这一步不经工具，由模型自己产出 */
export interface PlanStep {
  description: string
  capability?: string
}

export interface PlanRecord {
  id: string
  taskId: string
  version: number
  steps: PlanStep[]
  createdAt: string
}

/** 一个任务的完整投影：任务本体 + 最新版计划 + 按 seq 升序的事件 */
export interface TaskTimeline {
  task: TaskRecord
  /** null = 这个任务没有计划（比如启动时被收成的孤儿任务） */
  plan: PlanRecord | null
  events: ExecutionEventRecord[]
}

export const PERMISSION_DECISIONS = ['approved', 'denied'] as const

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** pending = 还没人点；approved / denied = 用户已决定。
 *
 *  没有 expired：过期由 `status === 'pending' && now > expiresAt` 投影得出，不落库。
 */
export type PermissionStatus = 'pending' | PermissionDecision

/** 查询时投影出的第四种状态 */
export type PermissionViewState = PermissionStatus | 'expired'

/** 一次工具调用的授权记录。批准之后内容不可变，只有 status 与 decidedAt 会被写第二次 */
export interface PermissionRecord {
  id: string
  taskId: string
  /** Python 侧 host.execute_tool 带来的 callId。一条 Permission 只对应一个 callId */
  toolCallId: string
  capability: string
  /** 绑定与路径规范化之后的参数的 canonical JSON 串 */
  argsCanonical: string
  argsHash: string
  status: PermissionStatus
  requestedAt: string
  expiresAt: string
  /** null = 还没决定 */
  decidedAt: string | null
  /** 批准当时 UI 展示的来源绝对路径。影响文件数量就是它的长度，不单独存 */
  sourcePaths: string[]
  /** 批准当时 UI 展示的目标绝对路径。不是每个能力都有 */
  targetPath: string | null
}

/** main → renderer 的批准通道载荷。broker 产出，preload 原样转发，renderer 不做二次解析。
 */
export type PermissionNotice =
  | { readonly kind: 'requested'; readonly permission: PermissionRecord }
  | {
      readonly kind: 'resolved'
      readonly permissionId: string
      readonly state: PermissionViewState
    }

/** tool_executions 表的三种执行状态。
 *
 *  attempting = 执行前写入，副作用结果未知；succeeded / failed = 执行后翻转的终态。
 */
export const TOOL_EXECUTION_STATUSES = ['attempting', 'succeeded', 'failed'] as const

export type ToolExecutionStatus = (typeof TOOL_EXECUTION_STATUSES)[number]

/** Reminder 的四种状态。与 reminders 表 CHECK、protocol 包 ReminderStatus 枚举同源。
 *
 *  scheduled = 待触发（重启恢复时重挂 timer，TASK-025）；
 *  firing = 触发中、通知结果未知；
 *  fired = 已发送，终态，永不再发；
 *  failed = 保留失败原因，只允许显式重试。
 */
export const REMINDER_STATUSES = ['scheduled', 'firing', 'fired', 'failed'] as const

export type ReminderStatus = (typeof REMINDER_STATUSES)[number]

/** 一次性阅读提醒。一个 Task 至多一条（reminders.task_id UNIQUE），
 *  重复的 scheduler.create 要么幂等命中（同 idempotencyKey），要么被拒。
 */
export interface ReminderRecord {
  id: string
  taskId: string
  /** 创建它的 scheduler.create callId。重试后会是新值，只作诊断，不参与幂等判定 */
  toolCallId: string
  /** binder 规范化后的 UTC ISO 触发时间（毫秒三位 + Z）。批准面板展示的就是这个串 */
  remindAt: string
  /** 到期通知的正文（PRD 4.8 Reminder 的「通知内容」） */
  message: string
  /** scheduler.create:{argsHash}，与 tool_executions 的 key 同构。重试时比对它决定幂等返回还是拒绝 */
  idempotencyKey: string
  status: ReminderStatus
  createdAt: string
  updatedAt: string
  /** 翻到 fired 的时刻。null = 还没触发过 */
  firedAt: string | null
  /** 翻到 failed 时的原因。null = 没失败过 */
  failureReason: string | null
}

/** 一次 WRITE 副作用的幂等执行记录。idempotencyKey = capability + ':' + argsHash
 *  只要移动的是同一批绝对路径，key 不变就命中同一条。
 */
export interface ToolExecutionRecord {
  idempotencyKey: string
  taskId: string
  /** 最近一次执行的 callId。重启后会变，只作诊断，不参与幂等判定 */
  toolCallId: string
  capability: string
  argsHash: string
  /** recovery resolver 判定文件系统真实状态要用的来源绝对路径 */
  sourcePaths: string[]
  /** recovery resolver 判定文件系统真实状态要用的目标绝对路径。不是每个能力都有 */
  targetPath: string | null
  status: ToolExecutionStatus
  attemptedAt: string
  /** null = 还没翻转终态（attempting 中，或崩溃遗留） */
  finishedAt: string | null
  /** succeeded 时缓存的执行结果，命中已执行时原样返回。null = 非 succeeded */
  resultPayload: unknown | null
}
