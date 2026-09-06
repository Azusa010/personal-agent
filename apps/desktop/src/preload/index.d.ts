import type { RuntimeStatus, ListPdfsResult } from '../shared/ipc-contract'

export type { RuntimeStatus, ListPdfsResult }

declare global {
  interface Window {
    personalAgent: PersonalAgentApi
  }
}

export type RuntimeStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'crashed'
  detail?: string
}


export type PersonalAgentApi = {
  runtimeStatus(): Promise<RuntimeStatus>
  listPdfs(rootId: 'downloads'): Promise<ListPdfsResult>
}
