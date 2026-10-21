import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { isThemePreference, type ThemePreference } from '../../shared/theme'
import { SETTINGS_ERROR_CODE } from './error-code'

/** 外观文件在 userData 下的文件名。与 model-settings.json 平级，但不含敏感信息。 */
export const APPEARANCE_FILE_NAME = 'appearance.json'

/** 文件格式版本。读到的版本不是它，整份按「未配置」处理，回落到默认偏好。 */
export const APPEARANCE_VERSION = 1

interface StoredAppearance {
  version: number
  themePreference: ThemePreference
}

export interface AppearanceStoreDeps {
  /** appearance.json 的绝对路径（生产是 userData/appearance.json） */
  filePath: string
}

export interface AppearanceStore {
  /** 读不到 / 坏文件 / 版本不符 / 值越界，一律返回 null，由调用方回落到默认偏好。 */
  load(): ThemePreference | null
  save(preference: ThemePreference): void
}

export class AppearanceSaveError extends Error {
  constructor(
    readonly code: (typeof SETTINGS_ERROR_CODE)[keyof typeof SETTINGS_ERROR_CODE],
    message: string
  ) {
    super(message)
    this.name = 'AppearanceSaveError'
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function loadThemePreference(deps: AppearanceStoreDeps): ThemePreference | null {
  let raw: string
  try {
    raw = readFileSync(deps.filePath, 'utf8')
  } catch {
    return null
  }

  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }

  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null

  const record = stored as Record<string, unknown>
  if (record.version !== APPEARANCE_VERSION) return null

  return isThemePreference(record.themePreference) ? record.themePreference : null
}

export function saveThemePreference(preference: ThemePreference, deps: AppearanceStoreDeps): void {
  if (!isThemePreference(preference)) {
    throw new AppearanceSaveError(SETTINGS_ERROR_CODE.APPEARANCE_INVALID, '主题偏好不在合法集合内')
  }

  const stored: StoredAppearance = {
    version: APPEARANCE_VERSION,
    themePreference: preference
  }

  try {
    mkdirSync(dirname(deps.filePath), { recursive: true })
    writeFileSync(deps.filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  } catch (e) {
    throw new AppearanceSaveError(SETTINGS_ERROR_CODE.WRITE_FAILED, describe(e))
  }
}

export function createAppearanceStore(deps: AppearanceStoreDeps): AppearanceStore {
  return {
    load: () => loadThemePreference(deps),
    save: (preference: ThemePreference) => saveThemePreference(preference, deps)
  }
}
