import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { WINDOW_BACKGROUNDS } from '../../../../src/shared/theme'

const APP_CSS = readFileSync(join(__dirname, '../../../../src/renderer/src/assets/app.css'), 'utf8')

/** 取出某个选择器的声明块（只处理本项目这种单层、无嵌套的写法）。 */
function blockOf(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`app.css 缺少 ${selector} 声明块`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  if (close < 0) throw new Error(`app.css 的 ${selector} 声明块没有闭合`)
  return css.slice(open + 1, close)
}

function tokenOf(block: string, name: string): string | null {
  const matched = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
  return matched === null ? null : matched[1].trim()
}

const LIGHT = blockOf(APP_CSS, ':root')
const DARK = blockOf(APP_CSS, '.dark')

describe('app.css 主题 token', () => {
  it('声明了 color-scheme，原生控件（滚动条 / 表单 / 选区）才会跟着明暗走', () => {
    expect(LIGHT).toMatch(/color-scheme:\s*light/)
    expect(DARK).toMatch(/color-scheme:\s*dark/)
  })

  it('.dark 是真实深色，不是 :root 的复制品（防「同值假深色」回归）', () => {
    const tokens = [
      'background',
      'foreground',
      'card',
      'card-foreground',
      'popover',
      'primary',
      'primary-foreground',
      'secondary',
      'muted',
      'muted-foreground',
      'accent',
      'destructive',
      'border',
      'input',
      'ring',
      'success',
      'warning',
      'info',
      'code-bg',
      'overlay'
    ]

    for (const name of tokens) {
      const light = tokenOf(LIGHT, name)
      const dark = tokenOf(DARK, name)
      expect(light, `:root 缺少 --${name}`).not.toBeNull()
      expect(dark, `.dark 缺少 --${name}`).not.toBeNull()
      expect(dark, `.dark 的 --${name} 与 :root 同值，深色下不会有任何变化`).not.toBe(light)
    }
  })

  it('深色底色下沉、前景提亮（方向不能反）', () => {
    expect(hexLuminance(tokenOf(DARK, 'background')!)).toBeLessThan(
      hexLuminance(tokenOf(DARK, 'foreground')!)
    )
    expect(hexLuminance(tokenOf(LIGHT, 'background')!)).toBeGreaterThan(
      hexLuminance(tokenOf(LIGHT, 'foreground')!)
    )
  })

  it('窗口底色与 app.css 的 --background 严格同值，否则首帧会闪一下', () => {
    expect(tokenOf(LIGHT, 'background')).toBe(WINDOW_BACKGROUNDS.light)
    expect(tokenOf(DARK, 'background')).toBe(WINDOW_BACKGROUNDS.dark)
  })

  it('深色下正文与底色对比度达标（WCAG AA 4.5:1）', () => {
    const ratio = contrastRatio(tokenOf(DARK, 'foreground')!, tokenOf(DARK, 'background')!)
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(4.5)
  })

  it('标签文字（--muted-foreground）在深色底上仍然可读', () => {
    const ratio = contrastRatio(tokenOf(DARK, 'muted-foreground')!, tokenOf(DARK, 'background')!)
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(4.5)
  })

  it('不再残留旧纸感主题的颜色', () => {
    const lowered = APP_CSS.toLowerCase()
    for (const legacy of ['#efe9dd', '#ede9e0', '#252420', '#fdf3e2', '#3a372f']) {
      expect(lowered).not.toContain(legacy)
    }
  })
})

function hexLuminance(hex: string): number {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: string, b: string): number {
  const la = hexLuminance(a)
  const lb = hexLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}
