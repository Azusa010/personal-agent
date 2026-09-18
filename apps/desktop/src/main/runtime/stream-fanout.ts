/**
 * 实时通知的进程内总线
 *
 */

import { AgentStreamNotice } from 'src/shared/ipc-contract'

type listener = (notice: AgentStreamNotice) => void

const listeners: Set<listener> = new Set()

export function onAgentStream(listener: listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishAgentStream(notice: AgentStreamNotice): void {
  for (const listener of [...listeners]) {
    try {
      listener(notice)
    } catch (err) {
      console.error('[stream] 订阅者处理通知失败', err)
    }
  }
}
