import { GetConversationResult, MessageView } from 'src/shared/ipc-contract'
import { EventRepository } from '../product-state/event-repository'
import { MessageRepository } from '../product-state/message-repository'
import { PlanRepository } from '../product-state/plan-repository'
import { TaskRepository } from '../product-state/task-repository'
import { ERROR_CODE } from '@personal-agent/protocol'
import { projectTimeline } from '../product-state/timeline-projection'

export interface GetConversationDeps {
  messages: MessageRepository
  tasks: TaskRepository
  plans: PlanRepository
  events: EventRepository
}

// 一段会话的消息投影
export async function getConversation(
  conversationId: unknown,
  deps: GetConversationDeps
): Promise<GetConversationResult> {
  if (typeof conversationId !== 'string' || conversationId.trim() === '') {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: 'conversationId 必须是非空字符串'
    }
  }

  const rows = deps.messages.listByConversation(conversationId)
  const messages: MessageView[] = rows.map((row) => ({
    seq: row.seq,
    id: row.id,
    role: row.role,
    text: row.text,
    taskId: row.taskId,
    createdAt: row.createdAt,
    timeline:
      row.taskId === null ? null : projectTimeline(deps.tasks, deps.events, deps.plans, row.taskId)
  }))
  return { ok: true, messages }
}
