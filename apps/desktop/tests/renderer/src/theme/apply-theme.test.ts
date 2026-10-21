import { describe, expect, it } from 'vitest'

import { applyThemeToRoot, type ThemeRoot } from '../../../../src/renderer/src/lib/theme'
import { EFFECTIVE_THEMES } from '../../../../src/shared/theme'

/** 最小假根节点：只保留 applyThemeToRoot 用到的两个成员，不引 jsdom。 */
function fakeRoot(initialClasses: string[] = []): { root: ThemeRoot; classes: Set<string> } {
  const classes = new Set(initialClasses)
  const root: ThemeRoot = {
    classList: {
      toggle(token: string, force?: boolean): void {
        const shouldAdd = force ?? !classes.has(token)
        if (shouldAdd) classes.add(token)
        else classes.delete(token)
      }
    },
    style: { colorScheme: '' }
  }
  return { root, classes }
}

describe('renderer/lib/theme applyThemeToRoot', () => {
  it('深色：加上 .dark 并把 color-scheme 设为 dark', () => {
    const { root, classes } = fakeRoot()
    applyThemeToRoot(root, 'dark')
    expect(classes.has('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
  })

  it('浅色：摘掉 .dark 并把 color-scheme 设为 light（原生滚动条要跟着回来）', () => {
    const { root, classes } = fakeRoot(['dark'])
    applyThemeToRoot(root, 'light')
    expect(classes.has('dark')).toBe(false)
    expect(root.style.colorScheme).toBe('light')
  })

  it('重复应用同一主题是幂等的', () => {
    const { root, classes } = fakeRoot()
    applyThemeToRoot(root, 'dark')
    applyThemeToRoot(root, 'dark')
    expect([...classes]).toEqual(['dark'])
    expect(root.style.colorScheme).toBe('dark')
  })

  it('来回切换不残留上一个主题', () => {
    const { root, classes } = fakeRoot()
    for (const theme of ['dark', 'light', 'dark', 'light'] as const) {
      applyThemeToRoot(root, theme)
      expect(classes.has('dark')).toBe(theme === 'dark')
      expect(root.style.colorScheme).toBe(theme)
    }
  })

  it('不碰其它 class（design-lab / 字体 / 第三人称样式标记都得留着）', () => {
    const { root, classes } = fakeRoot(['no-transitions', 'compact'])
    applyThemeToRoot(root, 'dark')
    shiftToLightAndBack(root)
    expect(classes.has('no-transitions')).toBe(true)
    expect(classes.has('compact')).toBe(true)
  })

  it('只有两种生效值，两种都必须被覆盖（防新增主题漏测）', () => {
    for (const theme of EFFECTIVE_THEMES) {
      const { root, classes } = fakeRoot()
      applyThemeToRoot(root, theme)
      expect(classes.has('dark')).toBe(theme === 'dark')
      expect(root.style.colorScheme).toBe(theme)
    }
  })
})

function shiftToLightAndBack(root: ThemeRoot): void {
  applyThemeToRoot(root, 'light')
  applyThemeToRoot(root, 'dark')
}
