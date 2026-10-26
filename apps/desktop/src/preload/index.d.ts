import type {
  RuntimeStatus,
  GetAppearanceResult,
  GetModelSettingsResult,
  ListPdfsResult,
  ListTasksResult,
  IndexedPdfsResult,
  PermissionDecision,
  PermissionListResult,
  PermissionNotice,
  PermissionRespondResult,
  RunTaskIpcResult,
  SetAppearanceInput,
  SetAppearanceResult,
  SetModelSettingsInput,
  SetModelSettingsResult,
  TimelineIpcResult,
  SummaryFact,
  TaskRecord,
  TaskTimeline,
  ListConversationsResult,
  GetConversationResult,
  SendMessageIpcResult,
  AgentStreamNotice,
  GetAgentProfileResult,
  SetAgentProfileInput,
  RunWorkflowIpcResult,
  ResetCircuitBreakerResult,
  A2UIFormSubmitParams,
  A2UIFormSubmitIpcResult,
  A2UIRenderNotice,
  A2UIUpdateNotice,
  ListBotsResult,
  GetBotResult,
  CreateBotInput,
  CreateBotResult,
  UpdateBotInput,
  UpdateBotResult,
  ListLogsIpcResult,
  GroupLogsIpcResult,
  ExportLogsIpcResult,
  ClearLogsIpcResult,
  LogsListParams,
  LogsGroupParams,
  LogsReportInput,
  ChooseWorkspaceResult,
  WorkspaceMutateResult,
  WorkspaceView
} from '../shared/ipc-contract'
import type { AppearanceView, EffectiveTheme } from '../shared/theme'

export type {
  RuntimeStatus,
  GetModelSettingsResult,
  ListPdfsResult,
  ListTasksResult,
  IndexedPdfsResult,
  PermissionDecision,
  PermissionListResult,
  PermissionNotice,
  PermissionRespondResult,
  RunTaskIpcResult,
  SetModelSettingsInput,
  SetModelSettingsResult,
  TimelineIpcResult,
  SummaryFact,
  TaskRecord,
  TaskTimeline
}

declare global {
  interface Window {
    personalAgent: PersonalAgentApi
  }
}

export type PersonalAgentApi = {
  runtimeStatus(): Promise<RuntimeStatus>
  listPdfs(rootId: 'workspace'): Promise<ListPdfsResult>
  indexedPdfs(): Promise<IndexedPdfsResult>
  /** 侧栏历史会话列表：全量任务，renderer 自己按天分组与倒序 */
  listTasks(): Promise<ListTasksResult>
  /** 侧栏会话列表：按最近更新倒序 */
  listConversations(): Promise<ListConversationsResult>
  /** 读一段会话的全部消息；assistant 消息内嵌任务 timeline */
  getConversation(conversationId: string): Promise<GetConversationResult>
  /** 发一条消息。conversationId 传 null = 开新会话；回包带会话 id；可指定 botId */
  sendMessage(input: {
    conversationId: string | null
    text: string
    botId?: string | null
  }): Promise<SendMessageIpcResult>
  /** 获取全部已注册的伴侣 Bot（携带各自唯一 conversationId） */
  listBots(): Promise<ListBotsResult>
  /** 根据 ID 查询 Bot 详情 */
  getBot(botId: string): Promise<GetBotResult>
  /** 创建自定义伴侣 Bot 并初始化专属伴随会话 */
  createBot(input: CreateBotInput): Promise<CreateBotResult>
  /** 更新伴侣 Bot 人设与名称 */
  updateBot(input: UpdateBotInput): Promise<UpdateBotResult>
  /** taskId 传 null 表示读最近创建的任务：应用重启后 renderer 的 state 已清空，没有这个入口就再也指不回上一个任务 */
  getTimeline(taskId: string | null): Promise<TimelineIpcResult>
  /** 批准面板的「批准 / 拒绝」。同结论重复调用无副作用，repeated 会是 true */
  respondPermission(
    permissionId: string,
    decision: PermissionDecision
  ): Promise<PermissionRespondResult>
  /** 诊断面板的权限记录。taskId 不接受 null：没有选中会话时调用方自己显示提示 */
  listPermissions(taskId: string): Promise<PermissionListResult>
  /** 设置面板要显示的模型配置。**没有 Key 明文**（SEC-008），只有 apiKeySet 布尔 */
  getModelSettings(): Promise<GetModelSettingsResult>
  /** 保存模型配置。留空的字段 = 保持不变；保存后 main 会在空闲时重启 runtime 生效 */
  setModelSettings(input: SetModelSettingsInput): Promise<SetModelSettingsResult>
  /** 当前工作区视图（current/home/书签列表） */
  getWorkspace(): Promise<WorkspaceView>
  /** 弹原生文件夹选择器并切换工作区；有任务 running 时拒切，取消时 changed=false */
  chooseWorkspace(): Promise<ChooseWorkspaceResult>
  /** 直切到书签指向的工作区（不走选择器）；有任务 running 时拒切 */
  switchWorkspace(dir: string): Promise<ChooseWorkspaceResult>
  /** 删除工作区书签。当前激活项会被拒（CURRENT_BOOKMARK） */
  removeWorkspaceBookmark(dir: string): Promise<WorkspaceMutateResult>
  /** 订阅 main 推来的批准事件。返回的函数取消订阅，组件卸载时必须调 */
  onPermissionNotice(listener: (notice: PermissionNotice) => void): () => void
  onAgentStream(listener: (notice: AgentStreamNotice) => void): () => void
  getAgentProfile(): Promise<GetAgentProfileResult>
  setAgentProfile(input: SetAgentProfileInput): Promise<SetModelSettingsResult>
  /** 执行确定性业务工作流 */
  runWorkflow(workflowId: string, inputs?: Record<string, unknown>): Promise<RunWorkflowIpcResult>
  /** 拒绝熔断器恢复为半开试探状态 (Human-in-the-loop) */
  resetCircuitBreaker(taskId: string, reason?: string): Promise<ResetCircuitBreakerResult>
  /** 提交 A2UI 声明式动态表单并回流 Agent 任务 */
  submitA2UIForm(params: A2UIFormSubmitParams): Promise<A2UIFormSubmitIpcResult>
  /** 订阅 main 推来的 A2UI 渲染事件 */
  onA2UIRender(listener: (notice: A2UIRenderNotice) => void): () => void
  /** 订阅 main 推来的 A2UI 卡片原地更新事件（同一 renderId 全量换 document） */
  onA2UIRenderUpdate(listener: (notice: A2UIUpdateNotice) => void): () => void
  /** 首帧主题：主进程通过 additionalArguments 注入，同步可用，供 renderer 在首帧前落 class */
  initialTheme: EffectiveTheme
  /** 读外观偏好（preference）与当前生效值（effective） */
  getAppearance(): Promise<GetAppearanceResult>
  /** 保存外观偏好并立即生效（不重启 runtime） */
  setAppearance(input: SetAppearanceInput): Promise<SetAppearanceResult>
  /** 订阅 main 推来的外观变化（用户切换或系统主题变化） */
  onAppearanceChanged(listener: (appearance: AppearanceView) => void): () => void
  /** 扁平记录列表，按 ts 倒序，默认 100 条 */
  listLogs(params?: LogsListParams): Promise<ListLogsIpcResult>
  /** 按 fingerprint 归组，默认只出 error 及以上、近 7 天 */
  groupLogs(params?: LogsGroupParams): Promise<GroupLogsIpcResult>
  /** 导出 7 天日志包到下载目录，返回文件路径 */
  exportLogs(params?: { days?: number }): Promise<ExportLogsIpcResult>
  /** 清空本系统的 jsonl 日志（不动其它文件） */
  clearLogs(): Promise<ClearLogsIpcResult>
  /** 在文件管理器里打开日志目录 */
  openLogsDir(): Promise<string>
  /** renderer 侧错误上报（全局钩子与 ErrorBoundary 共用），main 侧做 5s/10 条节流 */
  reportError(input: LogsReportInput): Promise<{ ok: true; dropped?: boolean }>
}
