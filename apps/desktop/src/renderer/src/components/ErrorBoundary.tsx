import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { reportRendererError } from '../lib/report-renderer-error'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 根级错误边界：子树渲染期异常不再白屏，而是展示可恢复的 fallback 并上报日志。
 * 上报走 reportRendererError → window.personalAgent.reportError，
 * 与全局错误钩子共用同一通道（见 preload/index.d.ts 的 reportError 注释）。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    reportRendererError({
      event: 'renderer.component_error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: { componentStack: errorInfo.componentStack ?? '' }
    })
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="grid h-screen w-full place-items-center bg-background px-6 text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <span aria-hidden className="text-3xl text-destructive">
              ⚠️
            </span>
            <h1 className="text-lg font-semibold">页面出错了</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              界面渲染遇到意外错误，错误已写入日志。可以尝试重新加载应用恢复。
            </p>
            {this.state.error.message !== '' && (
              <p className="max-w-full break-all font-mono text-xs text-muted-foreground">
                {this.state.error.message}
              </p>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-2 h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              重新加载
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
