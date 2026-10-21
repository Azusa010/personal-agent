import { describe, expect, it, vi } from 'vitest'

import { AppearanceSaveError, type AppearanceStore } from '../../../src/main/settings/appearance'
import { SETTINGS_ERROR_CODE } from '../../../src/main/settings/error-code'
import {
  applySystemAppearance,
  getAppearanceView,
  setThemePreference,
  type ThemeIpcDeps
} from '../../../src/main/theme/theme-ipc'
import type { AppearanceView, ThemePreference } from '../../../src/shared/theme'
import { ERROR_CODE } from '@personal-agent/protocol'

function fakeStore(initial: ThemePreference | null = null): AppearanceStore & {
  saved: ThemePreference[]
  setLoadError(error: unknown): void
  setSaveError(error: unknown): void
} {
  let current = initial
  let loadError: unknown = null
  let saveError: unknown = null
  const saved: ThemePreference[] = []

  return {
    saved,
    load: () => {
      if (loadError !== null) throw loadError
      return current
    },
    save: (preference: ThemePreference) => {
      if (saveError !== null) throw saveError
      current = preference
      saved.push(preference)
    },
    setLoadError: (error: unknown) => {
      loadError = error
    },
    setSaveError: (error: unknown) => {
      saveError = error
    }
  }
}

function fakeDeps(
  options: {
    preference?: ThemePreference | null
    systemPrefersDark?: boolean
    apply?: (appearance: AppearanceView) => void
  } = {}
): ThemeIpcDeps & { applied: AppearanceView[]; store: ReturnType<typeof fakeStore> } {
  const store = fakeStore(options.preference ?? null)
  const applied: AppearanceView[] = []
  return {
    store,
    applied,
    systemPrefersDark: () => options.systemPrefersDark ?? false,
    apply:
      options.apply ??
      ((appearance: AppearanceView) => {
        applied.push(appearance)
      })
  }
}

describe('theme-ipc 外观通道', () => {
  describe('getAppearanceView', () => {
    it('没配过时回落到 system，并按系统解析生效值', () => {
      const deps = fakeDeps({ preference: null, systemPrefersDark: true })
      expect(getAppearanceView(deps)).toEqual({
        ok: true,
        appearance: { preference: 'system', effective: 'dark' }
      })
    })

    it('手动偏好不被系统明暗覆盖', () => {
      const deps = fakeDeps({ preference: 'light', systemPrefersDark: true })
      expect(getAppearanceView(deps)).toEqual({
        ok: true,
        appearance: { preference: 'light', effective: 'light' }
      })
    })

    it('存储层真抛了如实回 READ_FAILED，不装成默认值', () => {
      const deps = fakeDeps()
      deps.store.setLoadError(new Error('disk on fire'))
      const result = getAppearanceView(deps)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe(SETTINGS_ERROR_CODE.READ_FAILED)
        expect(result.message).toContain('disk on fire')
      }
    })
  })

  describe('setThemePreference', () => {
    it('合法偏好：先落盘、再应用、回包带解析后的生效值', () => {
      const deps = fakeDeps({ systemPrefersDark: true })
      const result = setThemePreference({ preference: 'system' }, deps)

      expect(result).toEqual({
        ok: true,
        appearance: { preference: 'system', effective: 'dark' }
      })
      expect(deps.store.saved).toEqual(['system'])
      expect(deps.applied).toEqual([{ preference: 'system', effective: 'dark' }])
    })

    it('落盘发生在应用之前（顺序不能颠倒，否则偏好可能丢）', () => {
      const calls: string[] = []
      const store = fakeStore()
      const originalSave = store.save
      store.save = (preference: ThemePreference) => {
        calls.push('save')
        originalSave(preference)
      }
      setThemePreference(
        { preference: 'dark' },
        {
          store,
          systemPrefersDark: () => false,
          apply: () => calls.push('apply')
        }
      )
      expect(calls).toEqual(['save', 'apply'])
    })

    it('非法入参不落盘、不应用，回 PROTOCOL_INVALID_REQUEST', () => {
      const invalidInputs: unknown[] = [
        null,
        undefined,
        {},
        [],
        { preference: 'Dark' },
        { preference: 'sepia' },
        { preference: 1 },
        { theme: 'dark' }
      ]
      for (const input of invalidInputs) {
        const deps = fakeDeps()
        const result = setThemePreference(input, deps)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
        expect(deps.store.saved).toEqual([])
        expect(deps.applied).toEqual([])
      }
    })

    it('保存失败时把领域错误码透传出来，且不应用主题', () => {
      const deps = fakeDeps()
      deps.store.setSaveError(
        new AppearanceSaveError(SETTINGS_ERROR_CODE.WRITE_FAILED, '没有写权限')
      )
      const result = setThemePreference({ preference: 'dark' }, deps)
      expect(result).toEqual({
        ok: false,
        code: SETTINGS_ERROR_CODE.WRITE_FAILED,
        message: '没有写权限'
      })
      expect(deps.applied).toEqual([])
    })

    it('存储层抛非领域错误时也收敛成 WRITE_FAILED', () => {
      const deps = fakeDeps()
      deps.store.setSaveError(new Error('EACCES'))
      const result = setThemePreference({ preference: 'dark' }, deps)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe(SETTINGS_ERROR_CODE.WRITE_FAILED)
        expect(result.message).toContain('EACCES')
      }
    })

    it('应用阶段抛错不影响「已保存」这个事实', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const deps = fakeDeps({
          apply: () => {
            throw new Error('window gone')
          }
        })
        const result = setThemePreference({ preference: 'dark' }, deps)
        expect(result).toEqual({
          ok: true,
          appearance: { preference: 'dark', effective: 'dark' }
        })
        expect(deps.store.saved).toEqual(['dark'])
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('applySystemAppearance（系统明暗变化）', () => {
    it('preference=system 时按新系统状态重算并下发', () => {
      const deps = fakeDeps({ preference: 'system', systemPrefersDark: true })
      applySystemAppearance(deps)
      expect(deps.applied).toEqual([{ preference: 'system', effective: 'dark' }])
    })

    it('手动偏好下系统变化不干扰界面', () => {
      const deps = fakeDeps({ preference: 'light', systemPrefersDark: true })
      applySystemAppearance(deps)
      expect(deps.applied).toEqual([])
    })

    it('读取失败时只记日志，不抛给 nativeTheme 事件', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const deps = fakeDeps({ preference: 'system' })
        deps.store.setLoadError(new Error('boom'))
        expect(() => applySystemAppearance(deps)).not.toThrow()
        expect(deps.applied).toEqual([])
        expect(spy).toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })
  })
})
