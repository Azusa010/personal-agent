import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { ERROR_CODE } from '@personal-agent/protocol'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../../../src/main/product-state/database'
import { SqliteBotRepository } from '../../../src/main/product-state/bot-repository'
import { SqliteConversationRepository } from '../../../src/main/product-state/conversation-repository'
import {
  listBotsHandler,
  getBotHandler,
  createBotHandler,
  updateBotHandler,
  type BotIpcDeps
} from '../../../src/main/tasks/bot-ipc'

let db: SqliteDatabase | null = null

beforeEach(() => {
  db = openProductState(MEMORY_DB)
  migrate(db)
})

afterEach(() => {
  db?.close()
  db = null
})

function getDeps(): BotIpcDeps {
  return {
    bots: new SqliteBotRepository(db!),
    convs: new SqliteConversationRepository(db!),
    now: () => '2026-10-13T12:00:00.000Z',
    newId: () => 'bot-mock-uuid-1'
  }
}

describe('bot-ipc 业务处理层', () => {
  describe('listBotsHandler', () => {
    it('返回全部已注册 Bot，并携带各自唯一的 conversationId', () => {
      const deps = getDeps()
      const res = listBotsHandler(deps)

      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.bots.length).toBeGreaterThanOrEqual(3)

      const def = res.bots.find((b) => b.id === 'bot-default')
      expect(def).toBeDefined()
      expect(def?.isDefault).toBe(true)
      expect(def?.conversationId).toBe('c-bot-default')

      const coder = res.bots.find((b) => b.id === 'bot-coder')
      expect(coder?.conversationId).toBe('c-bot-coder')
    })
  })

  describe('getBotHandler', () => {
    it('合法 botId 返回完整 BotView（含专属 conversationId）', () => {
      const deps = getDeps()
      const res = getBotHandler('bot-coder', deps)

      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.bot.id).toBe('bot-coder')
      expect(res.bot.name).toBe('代码极客')
      expect(res.bot.conversationId).toBe('c-bot-coder')
    })

    it('不存在或非法 botId 返回 PROTOCOL_INVALID_REQUEST 失败响应', () => {
      const deps = getDeps()
      const res1 = getBotHandler('not-found', deps)
      expect(res1.ok).toBe(false)
      if (!res1.ok) {
        expect(res1.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
      }

      const res2 = getBotHandler('', deps)
      expect(res2.ok).toBe(false)
    })
  })

  describe('createBotHandler', () => {
    it('成功创建自定义 Bot 并自动初始化唯一的伴随会话', () => {
      const deps = getDeps()
      const input = {
        name: 'UI 设计师',
        avatar: '🎨',
        persona: '你是一个精通设计系统与用户体验的顾问...',
        description: '负责视觉规范、配色设计与交互建议'
      }

      const res = createBotHandler(input, deps)

      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.bot.id).toBe('bot-mock-uuid-1')
      expect(res.bot.name).toBe('UI 设计师')
      expect(res.bot.avatar).toBe('🎨')
      expect(res.bot.isDefault).toBe(false)
      expect(res.bot.conversationId).toBeTruthy()

      // 验证在会话库中真的创建了伴随会话
      const conv = deps.convs.findById(res.bot.conversationId)
      expect(conv).not.toBeNull()
      expect(conv?.botId).toBe('bot-mock-uuid-1')
    })

    it('名称为空或超长时拦截并返回校验失败', () => {
      const deps = getDeps()
      const resEmpty = createBotHandler({ name: '   ', avatar: '🎨', persona: 'p', description: 'd' }, deps)
      expect(resEmpty.ok).toBe(false)

      const resLong = createBotHandler({ name: 'x'.repeat(41), avatar: '🎨', persona: 'p', description: 'd' }, deps)
      expect(resLong.ok).toBe(false)
    })
  })

  describe('updateBotHandler', () => {
    it('支持更新自定义 Bot 的人设与名称', () => {
      const deps = getDeps()
      // 先创建一个
      createBotHandler({ name: '旧名称', avatar: '🐱', persona: '旧人设', description: '描述' }, deps)

      const res = updateBotHandler(
        { id: 'bot-mock-uuid-1', name: '新名称', persona: '全新人设' },
        deps
      )

      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.bot.name).toBe('新名称')
      expect(res.bot.persona).toBe('全新人设')
      expect(res.bot.avatar).toBe('🐱')
    })
  })
})
