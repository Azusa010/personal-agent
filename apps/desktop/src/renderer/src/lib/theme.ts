import type { EffectiveTheme } from '../../../shared/theme'

/**
 * 主题落到 DOM 的唯一入口。
 * 只依赖这两个成员，测试里给个最小假对象就够，不必为了一个 class 切换引入 jsdom。
 *
 * - class 决定 Tailwind 的 dark: 变体与 .dark token 块；
 * - color-scheme 决定浏览器原生部件（滚动条、表单控件、选区）的明暗，
 *   只写 class 不写它，深色下滚动条与 checkbox 还是亮的。
 */
export interface ThemeRoot {
  classList: { toggle(token: string, force?: boolean): void }
  style: { colorScheme: string }
}

export function applyThemeToRoot(root: ThemeRoot, theme: EffectiveTheme): void {
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}
