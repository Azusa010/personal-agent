import { describe, it, expect, afterEach } from 'vitest'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../../../src/main/product-state/database'
import {
  BotRecord,
  SqliteBotRepository
} from '../../../src/main/product-state/bot-repository'
import { SqliteConversationRepository } from '../../../src/main/product-state/conversation-repository'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

function makeRepo(): { bots: SqliteBotRepository; convs: SqliteConversationRepository } {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  return {
    bots: new SqliteBotRepository(d),
    convs: new SqliteConversationRepository(d)
  }
}

const NOW = '2026-10-13T10:00:00.000Z'

describe('SqliteBotRepository', () => {
  it('list() 返回所有 Bot，默认 Bot (isDefault=true) 排在最前', () => {
    const { bots } = makeRepo()
    const list = bots.list()

    expect(list.length).toBeGreaterThanOrEqual(3)
    expect(list[0].id).toBe('bot-default')
    expect(list[0].isDefault).toBe(true)
  })

  it('findDefault() 准确读取标记为 isDefault 的默认伴侣', () => {
    const { bots } = makeRepo()
    const def = bots.findDefault()

    expect(def).not.toBeNull()
    expect(def?.id).toBe('bot-default')
    expect(def?.name).toBe('PersonalAgent')
    expect(def?.isDefault).toBe(true)
  })

  it('findById 读回对应实体，不存在时返回 null', () => {
    const { bots } = makeRepo()

    const coder = bots.findById('bot-coder')
    expect(coder).not.toBeNull()
    expect(coder?.name).toBe('代码极客')
    expect(coder?.avatar).toBe('💻')

    expect(bots.findById('non-existent')).toBeNull()
  })

  it('insert 插入自定义 Bot，并通过 findById 完整读回（字段与驼峰映射）', () => {
    const { bots } = makeRepo()
    const custom: BotRecord = {
      id: 'bot-custom-1',
      name: '小说家伴侣',
      avatar: '📚',
      persona: '你是一个世界观构架师与科幻小说助手...',
      description: '协助梳理大纲、推敲对话与世界观设定',
      isDefault: false,
      createdAt: NOW,
      updatedAt: NOW
    }

    bots.insert(custom)

    const fetched = bots.findById('bot-custom-1')
    expect(fetched).toEqual(custom)
  })

  it('update 支持部分字段增量修改（人设/头像/名称更新）', () => {
    const { bots } = makeRepo()
    const custom: BotRecord = {
      id: 'bot-custom-2',
      name: '旧名字',
      avatar: '🐱',
      persona: '旧人设',
      description: '旧描述',
      isDefault: false,
      createdAt: NOW,
      updatedAt: NOW
    }
    bots.insert(custom)

    const updateTime = '2026-10-13T12:00:00.000Z'
    bots.update({
      id: 'bot-custom-2',
      name: '新名字·精炼版',
      persona: '崭新的大师级人设Prompt',
      updatedAt: updateTime
    })

    const after = bots.findById('bot-custom-2')
    expect(after?.name).toBe('新名字·精炼版')
    expect(after?.persona).toBe('崭新的大师级人设Prompt')
    expect(after?.avatar).toBe('🐱') // 未更新字段保持原样
    expect(after?.description).toBe('旧描述')
    expect(after?.updatedAt).toBe(updateTime)
  })

  it('外键约束：向不存在的 bot_id 插入会话时抛出 FOREIGN KEY 约束错误', () => {
    const { convs } = makeRepo()

    expect(() => {
      convs.insert({
        id: 'c-invalid',
        title: '无效外键会话',
        botId: 'non-existent-bot-id',
        createdAt: NOW,
        updatedAt: NOW
      })
    }).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('ConversationRepository 支持按 botId 查询该 Bot 的唯一伴随会话', () => {
    const { convs } = makeRepo()

    const defaultConv = convs.findByBotId('bot-default')
    expect(defaultConv).not.toBeNull()
    expect(defaultConv?.id).toBe('c-bot-default')
    expect(defaultConv?.botId).toBe('bot-default')

    const coderConv = convs.findByBotId('bot-coder')
    expect(coderConv).not.toBeNull()
    expect(coderConv?.id).toBe('c-bot-coder')
    expect(coderConv?.botId).toBe('bot-coder')
  })
})
