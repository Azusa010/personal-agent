import type {
  RuntimeStatus,
  ListPdfsResult,
  IndexedPdfsResult,
  RunTaskIpcResult,
  SummaryFact
} from '../shared/ipc-contract'

export type { RuntimeStatus, ListPdfsResult, IndexedPdfsResult, RunTaskIpcResult, SummaryFact }

declare global {
  interface Window {
    personalAgent: PersonalAgentApi
  }
}

export type PersonalAgentApi = {
  runtimeStatus(): Promise<RuntimeStatus>
  listPdfs(rootId: 'downloads'): Promise<ListPdfsResult>
  indexedPdfs(): Promise<IndexedPdfsResult>
  runTask(goal: string): Promise<RunTaskIpcResult>
}
