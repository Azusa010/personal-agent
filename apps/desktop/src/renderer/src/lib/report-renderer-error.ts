import type { LogsReportInput } from '../../../shared/ipc-contract'

function send(input: LogsReportInput): void {
  const api = window.personalAgent
  if (api === undefined || typeof api.reportError !== 'function') return
  void api.reportError(input).catch(() => undefined)
}

/** 全局渲染错误钩子。必须在应用挂载前调用，否则首次渲染的异常收不到。 */
export function installRendererErrorHooks(): () => void {
  const onError = (event: ErrorEvent): void => {
    send({
      event: 'renderer.window_error',
      message: event.message === '' ? '未命名渲染错误' : event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      context: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno
      }
    })
  }

  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason
    send({
      event: 'renderer.unhandled_rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined
    })
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

/** 组件层上报（ErrorBoundary / 手动 catch 用）。 */
export function reportRendererError(input: LogsReportInput): void {
  send(input)
}
