import type { PermissionRecord, PermissionViewState } from '../../shared/domain'

/**
 * 权限有效期
 */
export const PERMISSION_TTL_MS = 5 * 60 * 1000

/**
 * 计算权限有效期
 */
export function computeExpiresAt(requestedAt: string, ttlMs: number = PERMISSION_TTL_MS): string {
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
