import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { SqliteConversationRepository } from './conversation-repository'
import { MESSAGE_ROLES, SqliteMessageRepository } from './message-repository'
import { SqliteTaskRepository } from './task-repository'
import type { NewMessage } from './message-repository'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

const AT = '2026-09-17T09:00:00.000Z'

function makeRepo(): {
  messages: SqliteMessageRepository
  tasks: SqliteTaskRepository
} {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  const conversations = new SqliteConversationRepository(d)
  conversations.insert({ id: 'c-1', title: '会话一', createdAt: AT, updatedAt: AT })
  conversations.insert({ id: 'c-2', title: '会话二', createdAt: AT, updatedAt: AT })
  return {
    messages: new SqliteMessageRepository(d),
    tasks: new SqliteTaskRepository(d)
  }
}

function newMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    role: 'user',
    text: '你好',
    taskId: null,
    createdAt: AT,
    ...overrides
  }
}

describe('SqliteMessageRepository', () => {
  it('append 分配递增 seq，listByConversation 按 seq 升序读回', () => {
    const { messages } = makeRepo()
    const s1 = messages.append(newMessage({ id: 'm-1', text: '第一条' }))
    const s2 = messages.append(
      newMessage({ id: 'm-2', role: 'assistant', text: '第二条', taskId: null })
    )

    expect(s2).toBeGreaterThan(s1)
    expect(messages.listByConversation('c-1').map((m) => m.text)).toEqual(['第一条', '第二条'])
  })

  it('按会话隔离：c-2 的消息不串进 c-1', () => {
    const { messages } = makeRepo()
    messages.append(newMessage({ id: 'm-1' }))
    messages.append(newMessage({ id: 'm-2', conversationId: 'c-2', text: '别串' }))

    expect(messages.listByConversation('c-1').map((m) => m.id)).toEqual(['m-1'])
  })

  it('task_id 可空（用户消息先于任务存在）也可引用真实任务（助手消息挂任务）', () => {
    const { messages, tasks } = makeRepo()
    tasks.insert({
      id: 't-1',
      goal: '目标',
      status: 'pending',
      createdAt: AT,
      updatedAt: AT
    })
    messages.append(newMessage({ id: 'm-1', role: 'user', taskId: null }))
    messages.append(newMessage({ id: 'm-2', role: 'assistant', text: '回答', taskId: 't-1' }))

    const got = messages.listByConversation('c-1')
    expect(got[0]?.taskId).toBeNull()
    expect(got[1]?.taskId).toBe('t-1')
  })

  it('task_id 引用不存在的任务 → 外键拦下（消息不能挂在幻影任务上）', () => {
    const { messages } = makeRepo()

    expect(() =>
      messages.append(newMessage({ id: 'm-1', role: 'assistant', taskId: 't-幻影' }))
    ).toThrow()
  })

  it('role 全集逐个过真库（CHECK 与 domain.ts 的数组漂移在这里红）', () => {
    const { messages } = makeRepo()

    MESSAGE_ROLES.forEach((role, i) => {
      expect(() => messages.append(newMessage({ id: `m-${i}`, role }))).not.toThrow()
    })
  })

  it('role 出了数组 → CHECK 拒（先红在这里，不要等产品里静默存进脏行）', () => {
    const { messages } = makeRepo()

    expect(() => messages.append(newMessage({ id: 'm-x', role: 'system' as never }))).toThrow()
  })
})
