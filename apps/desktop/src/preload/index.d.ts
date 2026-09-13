import type {
  RuntimeStatus,
  ListPdfsResult,
  ListTasksResult,
  IndexedPdfsResult,
  RunTaskIpcResult,
  TimelineIpcResult,
  SummaryFact,
  TaskRecord,
  TaskTimeline
} from '../shared/ipc-contract'

export type {
  RuntimeStatus,
  ListPdfsResult,
  ListTasksResult,
  IndexedPdfsResult,
  RunTaskIpcResult,
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
  runTask(goal: string): Promise<RunTaskIpcResult>
  /** taskId 传 null 表示读最近创建的任务：应用重启后 renderer 的 state 已清空，没有这个入口就再也指不回上一个任务 */
  getTimeline(taskId: string | null): Promise<TimelineIpcResult>
}
