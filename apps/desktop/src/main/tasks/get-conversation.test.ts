import { describe, it, expect, afterEach } from 'vitest'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteConversationRepository } from '../product-state/conversation-repository'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqliteMessageRepository } from '../product-state/message-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { getConversation } from './get-conversation'

let db: SqliteDatabase | null = null
afterEach(() => {
  db?.close()
  db = null
})

const AT = '2026-09-17T09:00:00.000Z'

function makeDeps(): {
  messages: SqliteMessageRepository
  tasks: SqliteTaskRepository
  plans: SqlitePlanRepository
  events: SqliteEventRepository
} {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  const tasks = new SqliteTaskRepository(d)
  const plans = new SqlitePlanRepository(d)
  const events = new SqliteEventRepository(d)
  const messages = new SqliteMessageRepository(d)
  new SqliteConversationRepository(d).insert({
    id: 'c-1',
    title: '会话',
    createdAt: AT,
    updatedAt: AT
  })
  return { messages, tasks, plans, events }
}

describe('getConversation', () => {
  it('消息按 seq 升序读回；user 消息不带 timeline', async () => {
    const deps = makeDeps()
    deps.messages.append({
      id: 'm-1',
      conversationId: 'c-1',
      role: 'user',
      text: '第一问',
      taskId: null,
      createdAt: AT
    })

    const result = await getConversation('c-1', deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:第一问'])
    expect(result.messages[0]?.timeline).toBeNull()
  })

  it('assistant 消息内嵌其任务的 timeline（task + plan + events），折叠步骤直接用它', async () => {
    const deps = makeDeps()
    deps.tasks.insert({
      id: 't-1',
      goal: '整理 PDF',
      status: 'completed',
      createdAt: AT,
      updatedAt: AT
    })
    deps.plans.append({ id: 'p-1', taskId: 't-1', version: 1, steps: [], createdAt: AT })
    deps.events.append({
      taskId: 't-1',
      type: 'task_started',
      payload: { goal: '整理 PDF' },
      occurredAt: AT
    })
    deps.messages.append({
      id: 'm-1',
      conversationId: 'c-1',
      role: 'user',
      text: '第一问',
      taskId: null,
      createdAt: AT
    })
    deps.messages.append({
      id: 'm-2',
      conversationId: 'c-1',
      role: 'assistant',
      text: '第一答',
      taskId: 't-1',
      createdAt: AT
    })

    const result = await getConversation('c-1', deps)

    if (!result.ok) throw new Error('预期 ok:true')
    const assistant = result.messages[1]
    expect(assistant?.timeline?.task.id).toBe('t-1')
    expect(assistant?.timeline?.plan?.id).toBe('p-1')
    expect(assistant?.timeline?.events.map((e) => e.type)).toEqual(['task_started'])
  })

  it('会话还没有消息 → ok:true + 空数组（新会话的空态）', async () => {
    const deps = makeDeps()

    const result = await getConversation('c-1', deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages).toEqual([])
  })

  it('conversationId 非字符串或空串 → ok:false PROTOCOL_INVALID_REQUEST', async () => {
    const deps = makeDeps()

    for (const bad of [undefined, null, 42, '', '   ']) {
      const result = await getConversation(bad, deps)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('预期 ok:false')
      expect(result.code).toBe('PROTOCOL_INVALID_REQUEST')
    }
  })
})