import { describe, expect, it } from 'vitest'
import { formatMarkdownReport } from '../../../../scripts/islands/markdown-formatter'
import { IslandReport } from '../../../../scripts/islands/types'

describe('formatMarkdownReport (Markdown 体检报告生成器)', () => {
  it('应当正确格式化包含 TS 和 Python 孤岛的完整报告，并生成文件链接', () => {
    const report: IslandReport = {
      timestamp: '2026-09-30 18:00:00',
      totalIssues: 2,
      tsCount: 1,
      pyCount: 1,
      issues: [
        {
          kind: 'unmounted_jsx',
          file: 'apps/desktop/src/renderer/src/App.tsx',
          line: 4,
          symbolName: 'Table',
          detail: '组件被 import 但未在任何 JSX 树中挂载渲染',
          language: 'typescript'
        },
        {
          kind: 'python_dead_code',
          file: 'services/agent-runtime/src/personal_agent/tools/calc.py',
          line: 42,
          symbolName: 'unused_calc',
          detail: '未被引用的函数',
          language: 'python'
        }
      ]
    }

    const md = formatMarkdownReport(report, 'D:/repo/PersonalAgent')
    expect(md).toContain('# 🏝️ PersonalAgent 孤岛与死代码检测报告')
    expect(md).toContain('共发现 **2** 处孤岛代码')
    expect(md).toContain('TypeScript/UI: **1** 处')
    expect(md).toContain('Python: **1** 处')
    expect(md).toContain('[JSX未挂载]')
    expect(md).toContain('`Table`')
    expect(md).toContain('[Python死代码]')
    expect(md).toContain('`unused_calc`')
    expect(md).toContain('file:///D:/repo/PersonalAgent/apps/desktop/src/renderer/src/App.tsx#L4')
  })

  it('当没有孤岛代码时，应展示清空状态', () => {
    const emptyReport: IslandReport = {
      timestamp: '2026-09-30 18:00:00',
      totalIssues: 0,
      tsCount: 0,
      pyCount: 0,
      issues: []
    }

    const md = formatMarkdownReport(emptyReport, 'D:/repo/PersonalAgent')
    expect(md).toContain('✅ 未发现 TypeScript / React 孤岛或死代码。')
    expect(md).toContain('✅ 未发现 Python 运行时死代码。')
  })
})
