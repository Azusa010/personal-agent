import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THEME_PREFERENCE,
  EFFECTIVE_THEMES,
  THEME_ARGV_PREFIX,
  THEME_PREFERENCES,
  TITLE_BAR_OVERLAYS,
  WINDOW_BACKGROUNDS,
  isEffectiveTheme,
  isThemePreference,
  parseThemeArgv,
  resolveEffectiveTheme,
  toAppearanceView
} from '../../src/shared/theme'

describe('shared/theme 主题单一事实来源', () => {
  it('偏好集合固定为 light / dark / system，且默认跟随系统', () => {
    expect([...THEME_PREFERENCES]).toEqual(['light', 'dark', 'system'])
    expect(DEFAULT_THEME_PREFERENCE).toBe('system')
    expect([...EFFECTIVE_THEMES]).toEqual(['light', 'dark'])
  })

  describe('isThemePreference', () => {
    it('接受三个合法偏好', () => {
      for (const preference of THEME_PREFERENCES) {
        expect(isThemePreference(preference)).toBe(true)
      }
    })

    it('拒绝大小写变体、空串、带空白的值与非法类型', () => {
      const rejected: unknown[] = [
        'Dark',
        'LIGHT',
        '',
        ' dark',
        'dark ',
        null,
        undefined,
        0,
        1,
        true,
        {},
        [],
        ['dark']
      ]
      for (const value of rejected) {
        expect(isThemePreference(value)).toBe(false)
      }
    })
  })

  describe('isEffectiveTheme', () => {
    it('只接受 light / dark，不接受 system', () => {
      expect(isEffectiveTheme('light')).toBe(true)
      expect(isEffectiveTheme('dark')).toBe(true)
      expect(isEffectiveTheme('system')).toBe(false)
      expect(isEffectiveTheme(null)).toBe(false)
    })
  })

  describe('resolveEffectiveTheme', () => {
    it('手动偏好不受系统影响', () => {
      expect(resolveEffectiveTheme('light', false)).toBe('light')
      expect(resolveEffectiveTheme('light', true)).toBe('light')
      expect(resolveEffectiveTheme('dark', false)).toBe('dark')
      expect(resolveEffectiveTheme('dark', true)).toBe('dark')
    })

    it('system 精确跟随系统明暗', () => {
      expect(resolveEffectiveTheme('system', true)).toBe('dark')
      expect(resolveEffectiveTheme('system', false)).toBe('light')
    })
  })

  describe('toAppearanceView', () => {
    it('没有持久化偏好时回落到 system，并按系统解析生效值', () => {
      expect(toAppearanceView(null, true)).toEqual({ preference: 'system', effective: 'dark' })
      expect(toAppearanceView(null, false)).toEqual({ preference: 'system', effective: 'light' })
    })

    it('手动偏好保留 preference，effective 与之相同（与系统无关）', () => {
      expect(toAppearanceView('dark', false)).toEqual({ preference: 'dark', effective: 'dark' })
      expect(toAppearanceView('light', true)).toEqual({ preference: 'light', effective: 'light' })
    })
  })

  describe('parseThemeArgv', () => {
    it('从混有 electron 启动参数的 argv 中取出注入的主题', () => {
      const argv = [
        'electron.exe',
        '--enable-logging',
        `${THEME_ARGV_PREFIX}dark`,
        'app/index.html'
      ]
      expect(parseThemeArgv(argv)).toBe('dark')
    })

    it('没有注入参数时返回 null', () => {
      expect(parseThemeArgv(['electron.exe', 'app/index.html'])).toBeNull()
      expect(parseThemeArgv([])).toBeNull()
    })

    it('值非法时返回 null，不猜成 light 或 dark', () => {
      expect(parseThemeArgv([`${THEME_ARGV_PREFIX}system`])).toBeNull()
      expect(parseThemeArgv([`${THEME_ARGV_PREFIX}`])).toBeNull()
      expect(parseThemeArgv([`${THEME_ARGV_PREFIX}DARK`])).toBeNull()
    })

    it('前缀不是完整匹配时不会被误当主题（防止 --pa-theme-x 之类的前缀撞车）', () => {
      expect(parseThemeArgv(['--pa-theme-extra=dark'])).toBeNull()
    })
  })

  describe('原生窗口配色', () => {
    it('窗口底色与标题栏 overlay 都区分明暗两套，且互不相同', () => {
      expect(WINDOW_BACKGROUNDS.light).not.toBe(WINDOW_BACKGROUNDS.dark)
      expect(TITLE_BAR_OVERLAYS.light).not.toEqual(TITLE_BAR_OVERLAYS.dark)
      for (const theme of EFFECTIVE_THEMES) {
        expect(WINDOW_BACKGROUNDS[theme]).toMatch(/^#[0-9a-fA-F]{6}$/)
        expect(TITLE_BAR_OVERLAYS[theme].color).toMatch(/^#[0-9a-fA-F]{6}$/)
        expect(TITLE_BAR_OVERLAYS[theme].symbolColor).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
    })

    it('不再残留旧纸感主题的窗控钮色', () => {
      const serialized = JSON.stringify(TITLE_BAR_OVERLAYS).toLowerCase()
      for (const legacy of ['#efe9dd', '#ede9e0', '#252420', '#6e675a', '#736d63', '#e6e2dc']) {
        expect(serialized).not.toContain(legacy)
      }
    })
  })
})
