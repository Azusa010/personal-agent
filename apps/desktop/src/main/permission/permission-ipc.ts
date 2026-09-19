import { ERROR_CODE } from '@personal-agent/protocol'

import { PERMISSION_DECISIONS } from '../../shared/domain'
import type { PermissionDecision } from '../../shared/domain'
import type {
  IpcErrorCode,
  PermissionListResult,
  PermissionRespondResult
} from '../../shared/ipc-contract'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'
import type { PermissionBroker } from './permission-broker'

export interface PermissionIpcDeps {
  readonly broker: PermissionBroker
}

// broker.respond 的失败只可能来自这三条码。白名单之外的值说明是库层面的意外，
const KNOWN_RESPOND_CODES: ReadonlySet<IpcErrorCode> = new Set<IpcErrorCode>([
  ERROR_CODE.PERMISSION_REQUIRED,
  ERROR_CODE.PERMISSION_DENIED,
  ERROR_CODE.PERMISSION_EXPIRED,
  ERROR_CODE.PERMISSION_TAMPERED
])

function toIpcCode(code: string): IpcErrorCode {
  const known = code as IpcErrorCode
  return KNOWN_RESPOND_CODES.has(known) ? known : RUNTIME_ERROR_CODE.DB_FAILED
}

function invalid(message: string): { ok: false; code: IpcErrorCode; message: string } {
  return { ok: false, code: ERROR_CODE.PROTOCOL_INVALID_REQUEST, message }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface PermissionRespondInput {
  readonly permissionId?: unknown
  readonly decision?: unknown
  readonly reason?: unknown
}

/** 批准面板的「批准 / 拒绝」。入参来自 renderer，一律不可信，先收窄再交给 broker。 */
export function respondToPermission(
  input: PermissionRespondInput,
  deps: PermissionIpcDeps
): PermissionRespondResult {
  const { permissionId, decision } = input
  if (typeof permissionId !== 'string' || permissionId.length === 0) {
    return invalid(`permissionId 必须是非空字符串，收到: ${String(permissionId)}`)
  }
  if (
    typeof decision !== 'string' ||
    !(PERMISSION_DECISIONS as readonly string[]).includes(decision)
  ) {
    return invalid(`decision 必须是 ${PERMISSION_DECISIONS.join(' | ')}，收到: ${String(decision)}`)
  }

  const cleanReason =
    typeof input.reason === 'string' && input.reason.trim().length > 0
      ? input.reason.trim()
      : undefined

  try {
    const outcome = deps.broker.respond(permissionId, decision as PermissionDecision, cleanReason)
    if (!outcome.ok) {
      return { ok: false, code: toIpcCode(outcome.code), message: outcome.reason }
    }
    return { ok: true, permission: outcome.permission, repeated: outcome.repeated }
  } catch (e) {
    return { ok: false, code: RUNTIME_ERROR_CODE.DB_FAILED, message: describe(e) }
  }
}

/** 诊断面板的只读观察区。taskId 不接受 null */
export function listTaskPermissions(
  taskId: unknown,
  deps: PermissionIpcDeps
): PermissionListResult {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return invalid(`taskId 必须是非空字符串，收到: ${String(taskId)}`)
  }
  try {
    return { ok: true, entries: deps.broker.listForTask(taskId) }
  } catch (e) {
    return { ok: false, code: RUNTIME_ERROR_CODE.DB_FAILED, message: describe(e) }
  }
}
