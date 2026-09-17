import { Turn } from '@personal-agent/protocol'
import { MessageRecord } from 'src/shared/domain'

export interface HistoryBudget {
  maxMessages: number
  maxChars: number
}

export const HISTORY_BUDGET: HistoryBudget = { maxMessages: 12, maxChars: 6000 }

export function buildHistory(messages: readonly MessageRecord[], budget: HistoryBudget): Turn[] {
  const history: Turn[] = []
  let chars = 0
  let msgCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msgCount >= budget.maxMessages || chars + msg.text.length > budget.maxChars) {
      break
    }
    if (msgCount === budget.maxMessages - 1) {
      if (msg.role === 'assistant') {
        break
      }
    }
    history.unshift({
      role: msg.role,
      text: msg.text
    })
    msgCount++
    chars += msg.text.length
  }
  if (history.length > 0 && history[0].role === 'assistant') {
    return []
  }

  return history
}
