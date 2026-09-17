import { ERROR_CODE, Turn } from '@personal-agent/protocol'
import { RunTaskIpcResult, SendMessageIpcResult } from 'src/shared/ipc-contract'
import { ConversationRepository } from '../product-state/conversation-repository'
import { MessageRepository } from '../product-state/message-repository'
import { buildHistory, HISTORY_BUDGET } from './history'

const TITLE_MAX_CHARS = 24

function titleFrom(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TITLE_MAX_CHARS ? trimmed.slice(0, TITLE_MAX_CHARS) + '…' : trimmed
}

export type RunTaskFn = (goal: unknown, history: Turn[]) => Promise<RunTaskIpcResult>

export interface SendMessageInput {
  conversationId: string | null
  text: unknown
}

export interface SendMessageDeps {
  conversations: ConversationRepository
  messages: MessageRepository
  runTask: RunTaskFn
  buildHistory: typeof buildHistory
  now?: () => string
  newId?: () => string
}

export async function sendMessage(
  input: SendMessageInput,
  deps: SendMessageDeps
): Promise<SendMessageIpcResult> {
  const now = deps.now?.() ?? new Date().toISOString()

  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (text === '') {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: '消息不能为空',
      conversationId: input.conversationId ?? ''
    }
  }
  let conversationId = input.conversationId
  if (conversationId === null) {
    conversationId = deps.newId?.() ?? crypto.randomUUID()
    deps.conversations.insert({
      id: conversationId,
      title: titleFrom(text),
      createdAt: now,
      updatedAt: now
    })
  } else if (deps.conversations.findById(conversationId) === null) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: `会话不存在: ${conversationId}`,
      conversationId
    }
  }

  const prior = deps.messages.listByConversation(conversationId)
  const history = deps.buildHistory(prior, HISTORY_BUDGET)

  deps.messages.append({
    id: deps.newId?.() ?? crypto.randomUUID(),
    conversationId,
    role: 'user',
    text,
    taskId: null,
    createdAt: now
  })

  const result = await deps.runTask(text, history)

  const stamp = deps.now?.() ?? new Date().toISOString()
  const assistantText = result.ok
    ? result.status === 'completed'
      ? (result.reply ?? '')
      : (result.reason ?? '任务失败')
    : result.message

  deps.messages.append({
    id: deps.newId?.() ?? crypto.randomUUID(),
    conversationId,
    role: 'assistant',
    text: assistantText,
    taskId: result.ok ? result.taskId : null,
    createdAt: stamp
  })

  deps.conversations.touch(conversationId, stamp)
  return { ...result, conversationId }
}
