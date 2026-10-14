import { ERROR_CODE } from '@personal-agent/protocol'
import type {
  BotView,
  CreateBotInput,
  CreateBotResult,
  GetBotResult,
  ListBotsResult,
  UpdateBotInput,
  UpdateBotResult
} from 'src/shared/ipc-contract'
import type { BotRepository } from '../product-state/bot-repository'
import type { ConversationRepository } from '../product-state/conversation-repository'

export interface BotIpcDeps {
  bots: BotRepository
  convs: ConversationRepository
  now?: () => string
  newId?: () => string
}

export function listBotsHandler(deps: BotIpcDeps): ListBotsResult {
  try {
    const list = deps.bots.list()
    const bots: BotView[] = list.map((b) => {
      const conv = deps.convs.findByBotId(b.id)
      return {
        id: b.id,
        name: b.name,
        avatar: b.avatar,
        persona: b.persona,
        description: b.description,
        isDefault: b.isDefault,
        conversationId: conv?.id ?? '',
        createdAt: b.createdAt,
        updatedAt: b.updatedAt
      }
    })
    return { ok: true, bots }
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: `获取 Bot 列表失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export function getBotHandler(botId: unknown, deps: BotIpcDeps): GetBotResult {
  if (typeof botId !== 'string' || botId.trim() === '') {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: 'botId 不能为空'
    }
  }

  const id = botId.trim()
  const bot = deps.bots.findById(id)
  if (!bot) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: `Bot 不存在: ${id}`
    }
  }

  const conv = deps.convs.findByBotId(bot.id)
  return {
    ok: true,
    bot: {
      id: bot.id,
      name: bot.name,
      avatar: bot.avatar,
      persona: bot.persona,
      description: bot.description,
      isDefault: bot.isDefault,
      conversationId: conv?.id ?? '',
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt
    }
  }
}

export function createBotHandler(input: unknown, deps: BotIpcDeps): CreateBotResult {
  if (!input || typeof input !== 'object') {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: '创建参数不能为空'
    }
  }

  const raw = input as Partial<CreateBotInput>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > 40) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: 'Bot 名称不能为空且不能超过 40 个字符'
    }
  }

  const avatar = typeof raw.avatar === 'string' && raw.avatar.trim() ? raw.avatar.trim() : '🤖'
  const persona = typeof raw.persona === 'string' ? raw.persona.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const now = deps.now?.() ?? new Date().toISOString()
  const botId = deps.newId?.() ?? crypto.randomUUID()
  const convId = `c-${botId}`

  deps.bots.insert({
    id: botId,
    name,
    avatar,
    persona,
    description,
    isDefault: false,
    createdAt: now,
    updatedAt: now
  })

  deps.convs.insert({
    id: convId,
    botId,
    title: `与 ${name} 的对话`,
    createdAt: now,
    updatedAt: now
  })

  return {
    ok: true,
    bot: {
      id: botId,
      name,
      avatar,
      persona,
      description,
      isDefault: false,
      conversationId: convId,
      createdAt: now,
      updatedAt: now
    }
  }
}

export function updateBotHandler(input: unknown, deps: BotIpcDeps): UpdateBotResult {
  if (!input || typeof input !== 'object') {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: '更新参数不能为空'
    }
  }

  const raw = input as Partial<UpdateBotInput>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: 'id 不能为空'
    }
  }

  const existing = deps.bots.findById(id)
  if (!existing) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: `Bot 不存在: ${id}`
    }
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : undefined
  if (name !== undefined && (!name || name.length > 40)) {
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: 'Bot 名称不能为空且不能超过 40 个字符'
    }
  }

  const now = deps.now?.() ?? new Date().toISOString()
  deps.bots.update({
    id,
    name,
    avatar: typeof raw.avatar === 'string' ? raw.avatar.trim() : undefined,
    persona: typeof raw.persona === 'string' ? raw.persona.trim() : undefined,
    description: typeof raw.description === 'string' ? raw.description.trim() : undefined,
    updatedAt: now
  })

  const updated = deps.bots.findById(id) ?? existing
  const conv = deps.convs.findByBotId(id)

  return {
    ok: true,
    bot: {
      id: updated.id,
      name: updated.name,
      avatar: updated.avatar,
      persona: updated.persona,
      description: updated.description,
      isDefault: updated.isDefault,
      conversationId: conv?.id ?? '',
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    }
  }
}
