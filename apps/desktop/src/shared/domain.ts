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
