import type { ERROR_CODE, PdfEntry, RunTaskResult, SummaryFact } from '@personal-agent/protocol'
import type { RUNTIME_ERROR_CODE } from '../main/runtime/error-code'
import type {
  ExecutionEventRecord,
  PermissionDecision,
  PermissionNotice,
  PermissionRecord,
  PermissionViewState,
  PlanRecord,
  PlanStep,
  TaskRecord,
  TaskStatus,
  TaskTimeline
} from './domain'

export type { PdfEntry, SummaryFact }

export type { ExecutionEventRecord, PlanRecord, PlanStep, TaskRecord, TaskStatus, TaskTimeline }

export type { PermissionDecision, PermissionRecord, PermissionViewState }

export type { PermissionNotice }

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

/** 侧栏历史会话列表的数据源：全量任务，按创建时间升序。只读，不写库。 */
export type ListTasksResult =
  { ok: true; tasks: TaskRecord[] } | { ok: false; code: IpcErrorCode; message: string }

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

/** repeated=true 表示这条早就有结论了，本次点击没产生任何副作用。
 *  UI 不能把它当失败：结论与用户点的一致，只是来晚了。 */
export type PermissionRespondResult =
  | { ok: true; permission: PermissionRecord; repeated: boolean }
  | { ok: false; code: IpcErrorCode; message: string }

/** state 是投影值，含 expired。库里只有 pending / approved / denied 三种 status */
export type PermissionListResult =
  | { ok: true; entries: { permission: PermissionRecord; state: PermissionViewState }[] }
  | { ok: false; code: IpcErrorCode; message: string }
