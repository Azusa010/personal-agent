import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  APPEARANCE_FILE_NAME,
  APPEARANCE_VERSION,
  AppearanceSaveError,
  createAppearanceStore,
  loadThemePreference,
  saveThemePreference
} from '../../../src/main/settings/appearance'
import { SETTINGS_ERROR_CODE } from '../../../src/main/settings/error-code'
import { THEME_PREFERENCES, type ThemePreference } from '../../../src/shared/theme'

const TEST_DIR = join(__dirname, '../../../../tmp/test-appearance-' + process.pid)
const TEST_FILE = join(TEST_DIR, APPEARANCE_FILE_NAME)

describe('appearance 存储（外观主题持久化）', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('loadThemePreference', () => {
    it('文件不存在时返回 null（首次启动，由调用方回落默认偏好）', () => {
      expect(loadThemePreference({ filePath: join(TEST_DIR, 'missing.json') })).toBeNull()
    })

    it('内容不是合法 JSON 时返回 null，不抛', () => {
      writeFileSync(TEST_FILE, '{ themePreference: dark', 'utf8')
      expect(loadThemePreference({ filePath: TEST_FILE })).toBeNull()
    })

    it('顶层不是对象（数组 / 字符串 / null）时返回 null', () => {
      for (const raw of ['[]', '"dark"', 'null', '42']) {
        writeFileSync(TEST_FILE, raw, 'utf8')
        expect(loadThemePreference({ filePath: TEST_FILE })).toBeNull()
      }
    })

    it('版本号不匹配时整份丢弃', () => {
      writeFileSync(
        TEST_FILE,
        JSON.stringify({ version: APPEARANCE_VERSION + 1, themePreference: 'dark' }),
        'utf8'
      )
      expect(loadThemePreference({ filePath: TEST_FILE })).toBeNull()
    })

    it('偏好值越界时返回 null（手改文件不生效）', () => {
      for (const value of ['Dark', 'sepia', '', null, 1]) {
        writeFileSync(
          TEST_FILE,
          JSON.stringify({ version: APPEARANCE_VERSION, themePreference: value }),
          'utf8'
        )
        expect(loadThemePreference({ filePath: TEST_FILE })).toBeNull()
      }
    })

    it('缺少 themePreference 字段时返回 null', () => {
      writeFileSync(TEST_FILE, JSON.stringify({ version: APPEARANCE_VERSION }), 'utf8')
      expect(loadThemePreference({ filePath: TEST_FILE })).toBeNull()
    })
  })

  describe('saveThemePreference', () => {
    it('三种偏好都能原样 round-trip', () => {
      for (const preference of THEME_PREFERENCES) {
        saveThemePreference(preference, { filePath: TEST_FILE })
        expect(loadThemePreference({ filePath: TEST_FILE })).toBe(preference)
      }
    })

    it('落盘格式固定：version + themePreference，并以换行结尾', () => {
      saveThemePreference('dark', { filePath: TEST_FILE })
      const raw = readFileSync(TEST_FILE, 'utf8')
      expect(raw.endsWith('\n')).toBe(true)
      expect(JSON.parse(raw)).toEqual({
        version: APPEARANCE_VERSION,
        themePreference: 'dark'
      })
    })

    it('后写覆盖先写（不残留上一个偏好）', () => {
      saveThemePreference('light', { filePath: TEST_FILE })
      saveThemePreference('system', { filePath: TEST_FILE })
      expect(loadThemePreference({ filePath: TEST_FILE })).toBe('system')
    })

    it('非法偏好直接抛 APPEARANCE_INVALID，且不写文件', () => {
      const invalid = 'sepia' as ThemePreference
      let caught: unknown = null
      try {
        saveThemePreference(invalid, { filePath: TEST_FILE })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AppearanceSaveError)
      expect((caught as AppearanceSaveError).code).toBe(SETTINGS_ERROR_CODE.APPEARANCE_INVALID)
      expect(loadThemePreference({ filePath: TEST_FILE })).toBeNull()
    })

    it('目录不可建时抛 WRITE_FAILED，而不是静默失败', () => {
      const blocker = join(TEST_DIR, 'blocked')
      writeFileSync(blocker, 'not a directory', 'utf8')

      let caught: unknown = null
      try {
        saveThemePreference('dark', { filePath: join(blocker, 'appearance.json') })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AppearanceSaveError)
      expect((caught as AppearanceSaveError).code).toBe(SETTINGS_ERROR_CODE.WRITE_FAILED)
    })
  })

  describe('createAppearanceStore', () => {
    it('load / save 绑定到同一个 filePath', () => {
      const store = createAppearanceStore({ filePath: TEST_FILE })
      expect(store.load()).toBeNull()
      store.save('dark')
      expect(store.load()).toBe('dark')
    })
  })
})
