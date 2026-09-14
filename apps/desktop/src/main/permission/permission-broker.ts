import { randomUUID } from 'node:crypto'

import { ERROR_CODE } from '@personal-agent/protocol'

import type {
  PermissionDecision,
  PermissionNotice,
  PermissionRecord,
  PermissionViewState
} from '../../shared/domain'
import { resolveRoot } from '../capabilities/roots'
import type { BoundArgs } from '../policy/argument-binders'
import type { EventRepository } from '../product-state/event-repository'
import type { PermissionRepository } from '../product-state/permission-repository'
import { fingerprintArguments, type ArgumentFingerprint } from './args-hash'
import { computeExpiresAt, PERMISSION_TTL_MS, permissionState } from './expiry'
import { resolveWithinRootReal } from '../capabilities/path-guard'

export const PERMISSION_EVENT = {
  REQUESTED: 'permission_requested',
  DECISION: 'permission_decision',
  EXPIRED: 'permission_expired'
} as const

export type { PermissionNotice }

export interface PermissionRequestInput {
  readonly taskId: string
  /** Python 侧 host.execute_tool 带来的 callId，形如 'tc-9f3a' */
  readonly toolCallId: string
  readonly capability: string
  /** 策略第⑥⑦关的产物。*/
  readonly bound: BoundArgs
}

/** 挂起等待的结论。approved=false 时带码，调用方直接拿它构造工具失败结果 */
export type PermissionOutcome =
  | { readonly approved: true; readonly permission: PermissionRecord }
  | { readonly approved: false; readonly code: string; readonly reason: string }

/** respond 的结果。repeated=true 表示这条早就有结论了，本次调用没产生任何副作用 */
export type RespondResult =
  | { readonly ok: true; readonly permission: PermissionRecord; readonly repeated: boolean }
  | { readonly ok: false; readonly code: string; readonly reason: string }

export interface PermissionBrokerDeps {
  readonly permissions: PermissionRepository
  readonly events: EventRepository
  /** 默认 new Date().toISOString() */
  readonly now?: () => string
  /** 默认 randomUUID() */
  readonly newId?: () => string
  /** 默认 PERMISSION_TTL_MS（5 分钟） */
  readonly ttlMs?: number
  /** 默认 resolveRoot('downloads')。注入是为了让测试把根指到临时目录 */
  readonly root?: () => string
  /** 推给 Renderer 的出口。不传就只落库不推送。 */
  readonly notify?: (notice: PermissionNotice) => void
}

export interface PermissionBroker {
  /** 建 Permission、落库、推事件，然后挂起到有结论或过期 */
  request(input: PermissionRequestInput): Promise<PermissionOutcome>
  /** UI 的批准/拒绝。同结论重复调用无副作用 */
  respond(permissionId: string, decision: PermissionDecision): RespondResult
  /** 执行前的六步验证。委托给 verifyPermission */
  verify(toolCallId: string, bound: BoundArgs): Promise<PermissionVerifyResult>
  /** 库里属于这个任务的全部 Permission，带上过期投影 */
  listForTask(
    taskId: string,
    now?: string
  ): { permission: PermissionRecord; state: PermissionViewState }[]
  /** 清掉所有挂起的定时器。窗口关闭与应用退出时调 */
  dispose(): void
}

/** 从绑定结果里挑出批准面板要展示的路径。
 */
function splitPaths(
  capability: string,
  bound: BoundArgs
): { sourcePaths: string[]; targetPath: string | null } {
  switch (capability) {
    case 'filesystem.move': {
      const source = bound.paths['source']
      const target = bound.paths['target']
      return {
        sourcePaths: source === undefined ? [] : [source],
        targetPath: target ?? null
      }
    }
    case 'filesystem.create_dir':
      return { sourcePaths: [], targetPath: bound.paths['path'] ?? null }
    default:
      return { sourcePaths: Object.values(bound.paths), targetPath: null }
  }
}

export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker {
  const now = deps.now ?? ((): string => new Date().toISOString())
  const newId = deps.newId ?? ((): string => randomUUID())
  const ttlMs = deps.ttlMs ?? PERMISSION_TTL_MS
  const root = deps.root ?? ((): string => resolveRoot('downloads'))

  interface Waiter {
    readonly resolve: (outcome: PermissionOutcome) => void
    readonly timer: NodeJS.Timeout
  }

  const pending = new Map<string, Waiter>()

  function settle(permissionId: string, outcome: PermissionOutcome): void {
    const waiter = pending.get(permissionId)
    if (waiter === undefined) return
    pending.delete(permissionId)
    clearTimeout(waiter.timer)
    waiter.resolve(outcome)
  }

  function emitExpired(permission: PermissionRecord): void {
    const expiredAt = now()
    deps.events.append({
      taskId: permission.taskId,
      type: PERMISSION_EVENT.EXPIRED,
      payload: { permissionId: permission.id, expiresAt: permission.expiresAt },
      occurredAt: expiredAt
    })
    deps.notify?.({ kind: 'resolved', permissionId: permission.id, state: 'expired' })
  }

  return {
    async request(input) {
      const requestedAt = now()
      const fingerprint = fingerprintArguments(input.bound)
      const { sourcePaths, targetPath } = splitPaths(input.capability, input.bound)

      const permission: PermissionRecord = {
        id: newId(),
        taskId: input.taskId,
        toolCallId: input.toolCallId,
        capability: input.capability,
        argsCanonical: fingerprint.canonical,
        argsHash: fingerprint.hash,
        status: 'pending',
        requestedAt,
        expiresAt: computeExpiresAt(requestedAt, ttlMs),
        decidedAt: null,
        sourcePaths,
        targetPath
      }

      deps.permissions.insert(permission)
      deps.events.append({
        taskId: input.taskId,
        type: PERMISSION_EVENT.REQUESTED,
        payload: {
          permissionId: permission.id,
          capability: permission.capability,
          sourcePaths,
          targetPath,
          expiresAt: permission.expiresAt
        },
        occurredAt: requestedAt
      })
      deps.notify?.({ kind: 'requested', permission })

      return new Promise<PermissionOutcome>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(permission.id)
          emitExpired(permission)
          resolve({
            approved: false,
            code: ERROR_CODE.PERMISSION_EXPIRED,
            reason: `${permission.capability} 的批准请求在 ${ttlMs / 1000} 秒内没有响应，已过期`
          })
        }, ttlMs)

        pending.set(permission.id, { resolve, timer })
      })
    },

    respond(permissionId, decision) {
      const decidedAt = now()
      const before = deps.permissions.findById(permissionId)
      if (before === null) {
        return {
          ok: false,
          code: ERROR_CODE.PERMISSION_REQUIRED,
          reason: `permissions 中不存在 id=${permissionId}`
        }
      }

      if (before.status !== 'pending') {
        if (before.status === decision) {
          return { ok: true, permission: before, repeated: true }
        }
        return {
          ok: false,
          code: ERROR_CODE.PERMISSION_DENIED,
          reason: `${permissionId} 已经是 ${before.status}，不能再改成 ${decision}`
        }
      }

      if (!pending.has(permissionId)) {
        return {
          ok: false,
          code: ERROR_CODE.PERMISSION_EXPIRED,
          reason: `${permissionId} 的批准窗口已经关闭，无法再响应`
        }
      }

      const decided = deps.permissions.decide(permissionId, decision, decidedAt)
      deps.events.append({
        taskId: decided.taskId,
        type: PERMISSION_EVENT.DECISION,
        payload: { permissionId, decision, decidedAt },
        occurredAt: decidedAt
      })
      deps.notify?.({ kind: 'resolved', permissionId, state: decision })

      settle(
        permissionId,
        decision === 'approved'
          ? { approved: true, permission: decided }
          : {
              approved: false,
              code: ERROR_CODE.PERMISSION_DENIED,
              reason: `用户拒绝了 ${decided.capability}`
            }
      )

      return { ok: true, permission: decided, repeated: false }
    },

    async verify(toolCallId, bound) {
      return verifyPermission({
        permission: deps.permissions.findByToolCallId(toolCallId),
        fingerprint: fingerprintArguments(bound),
        toolCallId,
        now: now(),
        root: root()
      })
    },

    listForTask(taskId, at) {
      const stamp = at ?? now()
      return deps.permissions
        .findByTaskId(taskId)
        .map((permission) => ({ permission, state: permissionState(permission, stamp) }))
    },

    dispose() {
      for (const waiter of pending.values()) clearTimeout(waiter.timer)
      pending.clear()
    }
  }
}

export interface PermissionVerifyInput {
  /** 按 toolCallId 查出来的记录。null = 库里根本没有这条 */
  readonly permission: PermissionRecord | null
  /** 执行前重算的指纹，来自 fingerprintArguments(bound) */
  readonly fingerprint: ArgumentFingerprint
  /** 这次调用的 callId */
  readonly toolCallId: string
  readonly now: string
  /** 当前授权根，正斜杠绝对路径 */
  readonly root: string
}

export type PermissionVerifyResult =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string }

// 执行前的六步验证
export async function verifyPermission(
  input: PermissionVerifyInput
): Promise<PermissionVerifyResult> {
  // 1. permission === null
  if (input.permission === null) {
    return { ok: false, code: ERROR_CODE.PERMISSION_REQUIRED, reason: 'permission is null' }
  }

  // 2. permission.status !== 'approved'
  if (input.permission.status !== 'approved') {
    return { ok: false, code: ERROR_CODE.PERMISSION_DENIED, reason: 'permission is not approved' }
  }

  // 3.过期
  if (permissionState(input.permission, input.now) === 'expired') {
    return { ok: false, code: ERROR_CODE.PERMISSION_EXPIRED, reason: 'permission is expired' }
  }

  // 4. toolCallId 不对
  if (input.permission.toolCallId !== input.toolCallId) {
    return { ok: false, code: ERROR_CODE.PERMISSION_TAMPERED, reason: 'toolCallId does not match' }
  }

  // 5. argsHash 不对
  if (input.permission.argsHash !== input.fingerprint.hash) {
    return { ok: false, code: ERROR_CODE.PERMISSION_TAMPERED, reason: 'argsHash does not match' }
  }

  // 路经复查
  for (const sourcePath of input.permission.sourcePaths) {
    const result = await resolveWithinRootReal(input.root, sourcePath)
    if (result.ok === false) {
      return { ok: false, code: result.code, reason: result.reason }
    }
  }

  if (input.permission.targetPath !== null) {
    const targetResult = await resolveWithinRootReal(input.root, input.permission.targetPath)
    if (targetResult.ok === false) {
      return { ok: false, code: targetResult.code, reason: targetResult.reason }
    }
  }

  return { ok: true }
}
