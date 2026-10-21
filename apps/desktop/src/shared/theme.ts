/**
 * 外观主题的单一事实来源。主进程、preload、renderer 共用这一份，
 * 避免「浅色 / 深色 / system」三处各写一套字符串，也避免窗控钮配色与 CSS token 漂移。
 */

/** 用户可选的主题偏好。类型从数组派生，禁止手写联合类型。 */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** 真正生效的主题：preference=system 时由系统偏好解析而来。 */
export const EFFECTIVE_THEMES = ['light', 'dark'] as const
export type EffectiveTheme = (typeof EFFECTIVE_THEMES)[number]

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

/**
 * 主进程通过 webPreferences.additionalArguments 把首帧主题带给 preload。
 * 渲染层 CSP 是 script-src 'self'，内联脚本注入被禁，所以首帧主题只能走进程参数，
 * 不能走「HTML 里塞一段 <script>」的老办法。
 */
export const THEME_ARGV_PREFIX = '--pa-theme='

/** 窗口底色。必须与 app.css 的 --background 同值，否则首帧会闪一下。 */
export const WINDOW_BACKGROUNDS: Record<EffectiveTheme, string> = {
  light: '#ffffff',
  dark: '#0b0b0d'
}

/** Windows 自绘标题栏的系统窗控钮配色（height 由窗口创建处固定传 40）。 */
export const TITLE_BAR_OVERLAYS: Record<EffectiveTheme, { color: string; symbolColor: string }> = {
  light: { color: '#ffffff', symbolColor: '#3f3f46' },
  dark: { color: '#0b0b0d', symbolColor: '#e4e4e7' }
}

/** 外观视图：preference 是用户的持久化选择，effective 是当前真正生效的值。 */
export interface AppearanceView {
  preference: ThemePreference
  effective: EffectiveTheme
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
}

export function isEffectiveTheme(value: unknown): value is EffectiveTheme {
  return typeof value === 'string' && (EFFECTIVE_THEMES as readonly string[]).includes(value)
}

export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean
): EffectiveTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/**
 * 把「可能是 null 的持久化偏好」+ 系统偏好合成外观视图。
 * null（文件缺失 / 损坏 / 版本不符）一律回落到默认偏好，绝不猜值。
 */
export function toAppearanceView(
  preference: ThemePreference | null,
  systemPrefersDark: boolean
): AppearanceView {
  const effectivePreference = preference ?? DEFAULT_THEME_PREFERENCE
  return {
    preference: effectivePreference,
    effective: resolveEffectiveTheme(effectivePreference, systemPrefersDark)
  }
}

/** 从 argv 里取首帧主题；取不到返回 null，由调用方决定回落。 */
export function parseThemeArgv(argv: readonly string[]): EffectiveTheme | null {
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith(THEME_ARGV_PREFIX)) continue
    const value = arg.slice(THEME_ARGV_PREFIX.length)
    if (isEffectiveTheme(value)) return value
  }
  return null
}
