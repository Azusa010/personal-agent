import type { ERROR_CODE, PdfEntry, RunTaskResult, SummaryFact } from '@personal-agent/protocol'
import type { RUNTIME_ERROR_CODE } from '../main/runtime/error-code'
import type { ExecutionEventRecord, TaskRecord, TaskStatus, TaskTimeline } from './domain'

export type { PdfEntry, SummaryFact }

export type { ExecutionEventRecord, TaskRecord, TaskStatus, TaskTimeline }

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
      facts?: SummaryFact[]
      reason?: string
    }
  | { ok: false; code: IpcErrorCode; message: string }

export type TimelineIpcResult =
  { ok: true; timeline: TaskTimeline | null } | { ok: false; code: IpcErrorCode; message: string }
