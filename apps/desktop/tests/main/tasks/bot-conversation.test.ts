import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Turn, ProfileDto } from '@personal-agent/protocol'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../../../src/main/product-state/database'
import { SqliteBotRepository } from '../../../src/main/product-state/bot-repository'
import { SqliteConversationRepository } from '../../../src/main/product-state/conversation-repository'
import { SqliteMessageRepository } from '../../../src/main/product-state/message-repository'
import { SqliteTaskRepository } from '../../../src/main/product-state/task-repository'
import { sendMessage, type SendMessageDeps, type SendMessageInput } from '../../../src/main/tasks/send-message'
import { buildHistory } from '../../../src/main/tasks/history'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
  vi.restoreAllMocks()
})

const NOW = '2026-10-13T10:00:00.000Z'

function setupDeps(capturedProfiles: ProfileDto[]): {
  deps: SendMessageDeps
  bots: SqliteBotRepository
  convs: SqliteConversationRepository
  messages: SqliteMessageRepository
} {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)

  const tasks = new SqliteTaskRepository(d)
  tasks.insert({
    id: 'task-test-1',
    goal: '测试目标',
    status: 'completed',
    createdAt: NOW,
    updatedAt: NOW
  })

  const bots = new SqliteBotRepository(d)
  const convs = new SqliteConversationRepository(d)
  const messages = new SqliteMessageRepository(d)

  const runTask = vi.fn().mockImplementation(async (_goal: unknown, _history: Turn[], profile?: ProfileDto) => {
    if (profile) {
      capturedProfiles.push(profile)
    }
    return {
      ok: true,
      taskId: 'task-test-1',
      status: 'completed',
      reply: '收到，我是专职助手'
    }
  })

  let idCounter = 0
  const deps: SendMessageDeps = {
    conversations: convs,
    messages,
    bots,
    runTask,
    buildHistory,
    now: () => NOW,
    newId: () => {
      idCounter += 1
      return `id-generated-${idCounter}`
    }
  }

  return { deps, bots, convs, messages }
}

describe('Bot 专属伴随会话与任务执行接线 (sendMessage)', () => {
  it('与特定 Bot 对话时，runTask 准确注入该 Bot 的专属 persona 与 name', async () => {
    const capturedProfiles: ProfileDto[] = []
    const { deps, convs } = setupDeps(capturedProfiles)

    // c-bot-coder 属于内置的 'bot-coder'
    const coderConv = convs.findByBotId('bot-coder')
    expect(coderConv).not.toBeNull()

    const input: SendMessageInput = {
      conversationId: coderConv!.id,
      text: '请帮我写一个 Rust 异步并发队列'
    }

    const result = await sendMessage(input, deps)

    expect(result.ok).toBe(true)
    expect(result.conversationId).toBe(coderConv!.id)

    // 验证注入给任务运行时的 profile 为代码极客的角色
    expect(capturedProfiles.length).toBe(1)
    expect(capturedProfiles[0].name).toBe('代码极客')
    expect(capturedProfiles[0].persona).toContain('系统架构')
  })

  it('传入 botId 时自动寻址该 Bot 的单伴随会话，无需手动传 conversationId', async () => {
    const capturedProfiles: ProfileDto[] = []
    const { deps, convs } = setupDeps(capturedProfiles)

    const analystConv = convs.findByBotId('bot-analyst')
    expect(analystConv).not.toBeNull()

    const input: SendMessageInput = {
      conversationId: null,
      botId: 'bot-analyst',
      text: '分析一下特斯拉与比亚迪的供应链差异'
    }

    const result = await sendMessage(input, deps)

    expect(result.ok).toBe(true)
    // 自动落入该 Bot 的专属会话 c-bot-analyst 中
    expect(result.conversationId).toBe(analystConv!.id)
    expect(capturedProfiles[0].name).toBe('深度分析师')
  })

  it('未提供 botId 且会话无绑定时，平滑降级使用默认伴侣 (bot-default)', async () => {
    const capturedProfiles: ProfileDto[] = []
    const { deps, convs } = setupDeps(capturedProfiles)

    // 假设一个老会话（未指定 botId）
    convs.insert({
      id: 'c-legacy',
      title: '旧普通会话',
      botId: 'bot-default',
      createdAt: NOW,
      updatedAt: NOW
    })

    const input: SendMessageInput = {
      conversationId: 'c-legacy',
      text: '帮我记一下明天的会议'
    }

    const result = await sendMessage(input, deps)

    expect(result.ok).toBe(true)
    expect(capturedProfiles.length).toBe(1)
    expect(capturedProfiles[0].name).toBe('PersonalAgent')
  })
})
