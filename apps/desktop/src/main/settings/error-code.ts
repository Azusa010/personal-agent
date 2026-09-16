/** 设置通道的失败码。设置读写不依赖 runtime 与 product-state，
 *  所以单独一张表，由 shared/ipc-contract.ts 并进 IpcErrorCode 联合。 */
export const SETTINGS_ERROR_CODE = {
  READ_FAILED: 'SETTINGS_READ_FAILED',
  WRITE_FAILED: 'SETTINGS_WRITE_FAILED',
  // Windows 上密钥库走 DPAPI，实际不会亮；Linux 无密钥库或系统策略禁用时会出现。
  // 出现即拒写：明文密钥落盘不如不落。
  ENCRYPTION_UNAVAILABLE: 'SETTINGS_ENCRYPTION_UNAVAILABLE'
} as const
