import type { RuntimeStatus, ListPdfsResult } from '../shared/ipc-contract'

export type { RuntimeStatus, ListPdfsResult }

declare global {
  interface Window {
    personalAgent: PersonalAgentApi
  }
}

export type PersonalAgentApi = {
  runtimeStatus(): Promise<RuntimeStatus>
  listPdfs(rootId: 'downloads'): Promise<ListPdfsResult>
}
