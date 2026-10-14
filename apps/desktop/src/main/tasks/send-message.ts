import { ERROR_CODE, ProfileDto, Turn } from '@personal-agent/protocol'
import { RunTaskIpcResult, SendMessageIpcResult } from 'src/shared/ipc-contract'
import { ConversationRepository } from '../product-state/conversation-repository'
import { MessageRepository } from '../product-state/message-repository'
import { buildHistory, HISTORY_BUDGET } from './history'
import { BotRepository } from '../product-state/bot-repository'

const TITLE_MAX_CHARS = 24

function titleFrom(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TITLE_MAX_CHARS ? trimmed.slice(0, TITLE_MAX_CHARS) + '…' : trimmed
}

export type RunTaskFn = (
  goal: unknown,
  history: Turn[],
  profile?: ProfileDto
) => Promise<RunTaskIpcResult>

export interface SendMessageInput {
  conversationId: string | null
  text: unknown
  botId?: string | null
}

export interface SendMessageDeps {
  conversations: ConversationRepository
  messages: MessageRepository
  bots?: BotRepository
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
  let targetBotId = input.botId ?? null

  if (conversationId !== null) {
    const existing = deps.conversations.findById(conversationId)
    if (!existing) {
      return {
        ok: false,
        code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
        message: `会话不存在: ${conversationId}`,
        conversationId
      }
    }
    if (existing.botId) {
      targetBotId = existing.botId
    }
  }

  const bot = deps.bots
    ? (targetBotId ? deps.bots.findById(targetBotId) : null) ?? deps.bots.findDefault()
    : null

  if (conversationId === null) {
    const living = bot ? deps.conversations.findByBotId(bot.id) : null
    if (living) {
      conversationId = living.id
    } else {
      conversationId = deps.newId?.() ?? crypto.randomUUID()
      deps.conversations.insert({
        id: conversationId,
        title: titleFrom(text),
        createdAt: now,
        updatedAt: now,
        botId: bot?.id ?? targetBotId ?? 'bot-default'
      })
    }
  }

  const profile: ProfileDto | undefined = bot
    ? {
        name: bot.name,
        persona: bot.persona
      }
    : undefined

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

  const result = await deps.runTask(text, history, profile)

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
