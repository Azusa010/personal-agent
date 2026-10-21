import { z } from 'zod'

import { ERROR_CODE } from '@personal-agent/protocol'

import type {
  GetAppearanceResult,
  IpcErrorCode,
  SetAppearanceResult
} from '../../shared/ipc-contract'
import {
  THEME_PREFERENCES,
  toAppearanceView,
  type AppearanceView,
  type ThemePreference
} from '../../shared/theme'
import { AppearanceSaveError, type AppearanceStore } from '../settings/appearance'
import { SETTINGS_ERROR_CODE } from '../settings/error-code'

/**
 * 外观通道的依赖边界。
 * `apply` 负责「把主题落到所有窗口 + 广播给 renderer」，实现方必须自吞异常：
 * 偏好已经落盘，应用失败不该被说成保存失败。
 */
export interface ThemeIpcDeps {
  store: AppearanceStore
  systemPrefersDark(): boolean
  apply(appearance: AppearanceView): void
}

/** 入参来自 renderer，一律不可信。偏好的合法集合与 shared/theme.ts 同一份。 */
const SetAppearanceSchema = z.object({
  preference: z.enum(THEME_PREFERENCES)
})

function invalid(message: string): { ok: false; code: IpcErrorCode; message: string } {
  return { ok: false, code: ERROR_CODE.PROTOCOL_INVALID_REQUEST, message }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 读设置页要显示的外观现状。文件缺失 / 损坏 / 版本不符由 store 返回 null，
 * 这里统一回落到默认偏好（system），不把「没配过」当错误。
 */
export function getAppearanceView(deps: ThemeIpcDeps): GetAppearanceResult {
  let preference: ThemePreference | null
  try {
    preference = deps.store.load()
  } catch (e) {
    // load 的实现契约是「失败返回 null」，真抛了说明存储层坏了：如实报出，不装成默认值。
    return { ok: false, code: SETTINGS_ERROR_CODE.READ_FAILED, message: describe(e) }
  }

  return { ok: true, appearance: toAppearanceView(preference, deps.systemPrefersDark()) }
}

/**
 * 保存主题偏好并立即应用。顺序固定为「先落盘、后应用」：
 * 落盘成功即算保存成功，应用阶段的意外只影响当前窗口，不回滚用户的选择。
 */
export function setThemePreference(input: unknown, deps: ThemeIpcDeps): SetAppearanceResult {
  const parsed = SetAppearanceSchema.safeParse(input)
  if (!parsed.success) {
    return invalid(`外观参数不符合契约: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }

  const preference = parsed.data.preference

  try {
    deps.store.save(preference)
  } catch (e) {
    if (e instanceof AppearanceSaveError) return { ok: false, code: e.code, message: e.message }
    return { ok: false, code: SETTINGS_ERROR_CODE.WRITE_FAILED, message: describe(e) }
  }

  const appearance = toAppearanceView(preference, deps.systemPrefersDark())
  try {
    deps.apply(appearance)
  } catch (e) {
    console.error('[theme] 应用主题失败，本次仅在下次启动时生效', e)
  }

  return { ok: true, appearance }
}

/** 系统主题变化时（仅 preference=system）由主进程调用，重算并下发。 */
export function applySystemAppearance(deps: ThemeIpcDeps): void {
  const result = getAppearanceView(deps)
  if (!result.ok) {
    console.error('[theme] 系统主题变化后读取外观失败', result.message)
    return
  }
  if (result.appearance.preference !== 'system') return
  deps.apply(result.appearance)
}
