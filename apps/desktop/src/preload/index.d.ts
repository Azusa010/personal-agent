import type { RuntimeStatus, ListPdfsResult, IndexedPdfsResult } from '../shared/ipc-contract'

export type { RuntimeStatus, ListPdfsResult, IndexedPdfsResult }

declare global {
  interface Window {
    personalAgent: PersonalAgentApi
  }
}

export type PersonalAgentApi = {
  runtimeStatus(): Promise<RuntimeStatus>
  listPdfs(rootId: 'downloads'): Promise<ListPdfsResult>
  indexedPdfs(): Promise<IndexedPdfsResult>
}
