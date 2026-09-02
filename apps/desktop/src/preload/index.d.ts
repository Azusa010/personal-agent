declare global {
  interface Window {
    personalAgent: PersonalAgentApi
  }
}

export type RuntimeStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'crashed'
  detail?: string
}

export type PdfEntry = {
  name: string
  absolutePath: string
  modifiedAt: string
  sizeBytes: number
}

export type PersonalAgentApi = {
  runtimeStatus(): Promise<RuntimeStatus>
  listPdfs(rootId: 'downloads'): Promise<PdfEntry[]>
}
