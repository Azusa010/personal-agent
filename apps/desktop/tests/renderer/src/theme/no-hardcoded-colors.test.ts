import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = join(__dirname, '../../../../src/renderer/src')

/**
 * design-lab 是独立的设计走查原型：自带 --paper 系覆写、不挂生产主题，
 * 它的硬编码暖色是「原型要长这样」，不是漏改。
 */
const EXCLUDED_DIRS = ['design-lab']

/**
 * 只禁「裸颜色工具类」：`bg-[#f4f4f5]` 这类在深色下会固定成浅色块。
 * `bg-[var(--amber-tint)]` 与 `dark:shadow-[...]` 走的是 token / 明暗分支，允许。
 */
const FORBIDDEN: { pattern: RegExp; hint: string }[] = [
  { pattern: /\bbg-\[#/g, hint: 'bg-[#...] 换成语义 token（bg-muted / bg-card / bg-code-bg…）' },
  {
    pattern: /\btext-\[#/g,
    hint: 'text-[#...] 换成语义 token（text-foreground / text-muted-foreground…）'
  },
  { pattern: /\bborder-\[#/g, hint: 'border-[#...] 换成 border-border / border-input' },
  { pattern: /\bfrom-\[#/g, hint: 'from-[#...] 换成 from-info / from-muted 等 token' },
  { pattern: /\bto-\[#/g, hint: 'to-[#...] 换成 token 渐变' },
  { pattern: /\bbg-white\b/g, hint: 'bg-white 换成 bg-background / bg-card' },
  { pattern: /\bbg-black\b(?!\/)/g, hint: 'bg-black（无透明度）换成 bg-overlay / bg-code-bg' }
]

function listTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry.name)) continue
      files.push(...listTsxFiles(join(dir, entry.name)))
      continue
    }
    if (entry.name.endsWith('.tsx')) files.push(join(dir, entry.name))
  }
  return files
}

describe('renderer 生产界面不允许裸浅色（深色主题回归闸门）', () => {
  const files = listTsxFiles(RENDERER_SRC)

  it('扫描范围有效（防止路径写错导致空跑通过）', () => {
    expect(files.length).toBeGreaterThan(10)
    const sample = files.map((file) => relative(RENDERER_SRC, file).replace(/\\/g, '/'))
    expect(sample).toContain('components/Sidebar.tsx')
    expect(sample).toContain('components/Composer.tsx')
    expect(sample.every((file) => !file.startsWith('design-lab/'))).toBe(true)
  })

  it('没有任何裸 hex 颜色工具类', () => {
    const violations: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const lines = source.split('\n')
      for (const rule of FORBIDDEN) {
        lines.forEach((line, index) => {
          rule.pattern.lastIndex = 0
          if (!rule.pattern.test(line)) return
          violations.push(
            `${relative(RENDERER_SRC, file).replace(/\\/g, '/')}:${index + 1} → ${rule.hint}\n    ${line.trim()}`
          )
        })
      }
    }

    expect(violations.join('\n')).toBe('')
  })
})
