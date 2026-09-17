import type {
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
  TaskTimeline,
  ListConversationsResult,
  GetConversationResult,
  SendMessageIpcResult
} from '../shared/ipc-contract'

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
  listPdfs(rootId: 'downloads'): Promise<ListPdfsResult>
  indexedPdfs(): Promise<IndexedPdfsResult>
  /** 侧栏历史会话列表：全量任务，renderer 自己按天分组与倒序 */
  listTasks(): Promise<ListTasksResult>
  /** 侧栏会话列表：按最近更新倒序 */
  listConversations(): Promise<ListConversationsResult>
  /** 读一段会话的全部消息；assistant 消息内嵌任务 timeline */
  getConversation(conversationId: string): Promise<GetConversationResult>
  /** 发一条消息。conversationId 传 null = 开新会话；回包带会话 id */
  sendMessage(input: { conversationId: string | null; text: string }): Promise<SendMessageIpcResult>
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
  /** 订阅 main 推来的批准事件。返回的函数取消订阅，组件卸载时必须调 */
  onPermissionNotice(listener: (notice: PermissionNotice) => void): () => void
}
