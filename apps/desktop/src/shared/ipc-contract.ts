import type { ERROR_CODE, PdfEntry } from '@personal-agent/protocol'
import type { RUNTIME_ERROR_CODE } from '../main/runtime/error-code'

export type { PdfEntry }

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'crashed'

export interface RuntimeStatus {
  state: RuntimeState
  detail?: string
}

export type WireErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE]

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODE)[keyof typeof RUNTIME_ERROR_CODE]
export type IpcErrorCode = WireErrorCode | RuntimeErrorCode

export type ListPdfsResult =
  { ok: true; entries: PdfEntry[] } | { ok: false; code: IpcErrorCode; message: string }
