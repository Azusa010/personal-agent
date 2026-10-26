import {
  PERMISSION_NEVER_EXPIRES_AT,
  type PermissionRecord,
  type PermissionViewState
} from '../../shared/domain'

/**
 * 权限有效期。null = 不限期：批准卡没人点就一直等，不自动过期。
 */
export const PERMISSION_TTL_MS: number | null = null

/**
 * 计算权限有效期。ttlMs 为 null 时落到远期哨兵，语义是「永不自动过期」。
 */
export function computeExpiresAt(
  requestedAt: string,
  ttlMs: number | null = PERMISSION_TTL_MS
): string {
  if (ttlMs === null) return PERMISSION_NEVER_EXPIRES_AT
  return new Date(new Date(requestedAt).getTime() + ttlMs).toISOString()
}

/**
 * 计算权限状态
 */
export function permissionState(permission: PermissionRecord, now: string): PermissionViewState {
  if (permission.status === 'denied') {
    return 'denied'
  }
  if (now > permission.expiresAt) {
    return 'expired'
  }
  return permission.status
}
