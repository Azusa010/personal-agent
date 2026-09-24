import type {
  AgentStreamParams,
  ERROR_CODE,
  PdfEntry,
  RunTaskResult,
  SummaryFact
} from '@personal-agent/protocol'
import type { RUNTIME_ERROR_CODE } from '../main/runtime/error-code'
import type { SETTINGS_ERROR_CODE } from '../main/settings/error-code'
import type {
  ExecutionEventRecord,
  MessageRole,
  PermissionDecision,
  PermissionNotice,
  PermissionRecord,
  PermissionViewState,
  PlanRecord,
  PlanStep,
  TaskRecord,
  TaskStatus,
  TaskTimeline
} from './domain'

export type { PdfEntry, SummaryFact }

export type { ExecutionEventRecord, PlanRecord, PlanStep, TaskRecord, TaskStatus, TaskTimeline }

export type { PermissionDecision, PermissionRecord, PermissionViewState }

export type { PermissionNotice }

export type AgentStreamNotice = AgentStreamParams

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'crashed'

export interface RuntimeStatus {
  state: RuntimeState
  detail?: string
}

export type WireErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE]

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODE)[keyof typeof RUNTIME_ERROR_CODE]
export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODE)[keyof typeof SETTINGS_ERROR_CODE]
export type IpcErrorCode = WireErrorCode | RuntimeErrorCode | SettingsErrorCode

export type ListPdfsResult =
  { ok: true; entries: PdfEntry[] } | { ok: false; code: IpcErrorCode; message: string }

/** 侧栏历史会话列表的数据源：全量任务，按创建时间升序。只读，不写库。 */
export type ListTasksResult =
  { ok: true; tasks: TaskRecord[] } | { ok: false; code: IpcErrorCode; message: string }

export interface IndexedPdfEntry extends PdfEntry {
  rootId: string
  firstSeenAt: string
  lastSeenAt: string
}

export type IndexedPdfsResult =
  { ok: true; entries: IndexedPdfEntry[] } | { ok: false; code: IpcErrorCode; message: string }

export type RunTaskIpcResult =
  | {
      ok: true
      taskId: string
      status: RunTaskResult['status']
      reply?: string
      facts?: SummaryFact[]
      reason?: string
    }
  | { ok: false; code: IpcErrorCode; message: string }

export type SendMessageIpcResult = RunTaskIpcResult & { conversationId: string }

export interface RunWorkflowInput {
  workflowId: string
  inputs?: Record<string, unknown>
}

export type RunWorkflowIpcResult = RunTaskIpcResult

export type TimelineIpcResult =
  { ok: true; timeline: TaskTimeline | null } | { ok: false; code: IpcErrorCode; message: string }

/** repeated=true 表示这条早就有结论了，本次点击没产生任何副作用。
 *  UI 不能把它当失败：结论与用户点的一致，只是来晚了。 */
export type PermissionRespondResult =
  | { ok: true; permission: PermissionRecord; repeated: boolean }
  | { ok: false; code: IpcErrorCode; message: string }

/** state 是投影值，含 expired。库里只有 pending / approved / denied 三种 status */
export type PermissionListResult =
  | { ok: true; entries: { permission: PermissionRecord; state: PermissionViewState }[] }
  | { ok: false; code: IpcErrorCode; message: string }

/** 设置面板能看到的模型配置。**Key 明文不回传**：只给「配没配」的
 *  布尔值，面板显示「已配置，留空保持不变」。 */
export interface ModelSettingsView {
  apiKeySet: boolean
  model: string | null
  baseUrl: string | null
  apiProtocol: 'responses' | 'chat_completions' | null
  typesafeApiKeySet: boolean
  typesafeModel: string | null
  typesafeBaseUrl: string | null
  contextWindow: number | null
  mineruApiUrl: string | null
  mineruApiKeySet: boolean
}

export type GetModelSettingsResult =
  { ok: true; settings: ModelSettingsView } | { ok: false; code: IpcErrorCode; message: string }

/** 字段语义：不给 = 保持不变；model / baseUrl 传 null = 清空；
 *  apiKey 空串 = 保持不变，清空走显式的 clearApiKey。
 *  TypeSafe 与 MinerU 字段遵循相同语义。 */
export interface SetModelSettingsInput {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string
  clearApiKey?: boolean
  apiProtocol?: 'responses' | 'chat_completions' | null
  typesafeApiKey?: string
  clearTypesafeApiKey?: boolean
  typesafeModel?: string | null
  typesafeBaseUrl?: string | null
  contextWindow?: number | null
  mineruApiUrl?: string | null
  mineruApiKey?: string
  clearMineruApiKey?: boolean
}

/** applied 区分「已经重启生效」与「有任务在跑、留到下次启动」——两种都算保存成功，
 *  界面文案不能把它说成失败。 */
export type SetModelSettingsResult =
  | { ok: true; applied: 'restarted' | 'on-next-restart' }
  | { ok: false; code: IpcErrorCode; message: string }

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: string
}

export interface MessageView {
  seq: number
  id: string
  role: MessageRole
  text: string
  taskId: string | null
  createdAt: string
  timeline: TaskTimeline | null
}

export type ListConversationsResult =
  | { ok: true; conversations: ConversationSummary[] }
  | { ok: false; code: IpcErrorCode; message: string }

export type GetConversationResult =
  { ok: true; messages: MessageView[] } | { ok: false; code: IpcErrorCode; message: string }

// 定义助手视图形状
export interface AgentProfileView {
  name: string
  persona: string
  reasoningSummary: boolean
}

export type GetAgentProfileResult =
  { ok: true; profile: AgentProfileView } | { ok: false; code: IpcErrorCode; message: string }

export interface SetAgentProfileInput {
  name?: string
  persona?: string
  reasoningSummary?: boolean
}

export type SetAgentProfileResult =
  { ok: true; profile: AgentProfileView } | { ok: false; code: IpcErrorCode; message: string }
