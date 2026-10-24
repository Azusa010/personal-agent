import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../../../src/renderer/src/components/ErrorBoundary'
import type { LogsReportInput } from '../../../../src/shared/ipc-contract'
import * as React from 'react'

// repo 的 vitest 环境保持 node（无 jsdom），因此：
// - fallback 渲染以实例态驱动 render() 断言（React 19 SSR 不展开错误边界，见用例内注释）；
// - componentDidCatch 属 commit 阶段、SSR 不会调用，只能以实例方法直调断言上报逻辑。

/** 子组件锚点：同时让 JSX 经典运行时的 React 引用保持显式使用。 */
function Anchor(): React.JSX.Element {
  return <p>正常内容锚点</p>
}

const reportErrorMock = vi.fn<(input: LogsReportInput) => Promise<{ ok: true }>>()

describe('ErrorBoundary', () => {
  beforeEach(() => {
    reportErrorMock.mockReset()
    reportErrorMock.mockResolvedValue({ ok: true })
    vi.stubGlobal('window', { personalAgent: { reportError: reportErrorMock } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('进入错误态时渲染 fallback 而非子组件，错误信息可见且有恢复入口', () => {
    // 实测 React 19 的 renderToStaticMarkup 不展开错误边界（子组件错误直接 rethrow），
    // 且仓库无 jsdom，因此按 React 客户端捕获错误的真实跳转链驱动：
    // getDerivedStateFromError 落错误态 → render() 输出 fallback。
    const boundary = new ErrorBoundary({ children: <Anchor /> })
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('渲染炸了'))

    const html = renderToStaticMarkup(boundary.render())

    expect(html).toContain('页面出错了')
    expect(html).toContain('重新加载')
    expect(html).toContain('渲染炸了')
    // 正常子树不应出现
    expect(html).not.toContain('正常内容锚点')
  })

  it('未抛错时原样渲染子组件', () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary>
        <p>正常内容锚点</p>
      </ErrorBoundary>
    )
    expect(html).toContain('正常内容锚点')
    expect(html).not.toContain('页面出错了')
  })

  it('componentDidCatch 通过 window.personalAgent.reportError 上报，参数含错误信息与组件栈', () => {
    const boundary = new ErrorBoundary({ children: null })
    const error = new Error('渲染炸了')
    error.stack = 'Error: 渲染炸了\n    at Boom (boom.tsx:3:9)'

    boundary.componentDidCatch(error, { componentStack: '\n    at Boom\n    at App' })

    expect(reportErrorMock).toHaveBeenCalledTimes(1)
    const payload = reportErrorMock.mock.calls[0][0]
    expect(payload.event).toBe('renderer.component_error')
    expect(payload.message).toBe('渲染炸了')
    expect(payload.stack).toBe('Error: 渲染炸了\n    at Boom (boom.tsx:3:9)')
    expect(payload.context?.componentStack).toContain('at Boom')
  })

  it('preload 通道缺失时静默降级，不向渲染层抛错', () => {
    vi.stubGlobal('window', {})
    const boundary = new ErrorBoundary({ children: null })

    expect(() =>
      boundary.componentDidCatch(new Error('渲染炸了'), { componentStack: '' })
    ).not.toThrow()
    expect(reportErrorMock).not.toHaveBeenCalled()
  })

  it('App.tsx 根部已用 ErrorBoundary 包裹主内容（反孤岛接线锁）', () => {
    const appSource = readFileSync(join(__dirname, '../../../../src/renderer/src/App.tsx'), 'utf8')
    expect(appSource).toContain("import { ErrorBoundary } from './components/ErrorBoundary'")
    expect(appSource).toContain('return (\n    <ErrorBoundary>')
    expect(appSource).toContain('    </ErrorBoundary>\n  )')
  })
})
