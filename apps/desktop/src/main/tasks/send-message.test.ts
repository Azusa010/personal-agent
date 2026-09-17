import { describe, it, expect, afterEach } from 'vitest'
import type { Turn } from '@personal-agent/protocol'
import type { RunTaskIpcResult } from '../../shared/ipc-contract'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteConversationRepository } from '../product-state/conversation-repository'
import { SqliteMessageRepository } from '../product-state/message-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { sendMessage, type SendMessageDeps } from './send-message'
import type { MessageRecord } from '../../shared/domain'

let db: SqliteDatabase | null = null
afterEach(() => {
  db?.close()
  db = null
})

const AT = '2026-09-17T09:00:00.000Z'
const NOW = '2026-09-17T10:00:00.000Z'

interface RunTaskCall {
  goal: unknown
  history: Turn[]
}

function completed(): RunTaskIpcResult {
  return {
    ok: true,
    taskId: 't-1',
    status: 'completed',
    reply: '已整理好，结论见下。',
    facts: []
  }
}

function failed(): RunTaskIpcResult {
  return { ok: true, taskId: 't-2', status: 'failed', reason: '预算耗尽：已用 12 步' }
}

function planFailed(): RunTaskIpcResult {
  return { ok: false, code: 'PLAN_NOT_BUILDABLE', message: '计划没建出来' }
}

let idCounter = 0

function makeDeps(
  respond: (goal: unknown, history: Turn[]) => Promise<RunTaskIpcResult>,
  buildHistory?: SendMessageDeps['buildHistory']
): SendMessageDeps & {
  calls: RunTaskCall[]
  conversations: SqliteConversationRepository
  messages: SqliteMessageRepository
} {
  idCounter = 0
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  const conversations = new SqliteConversationRepository(d)
  const messages = new SqliteMessageRepository(d)
  const calls: RunTaskCall[] = []
  // 真 runTask 会在自己的事务 A 里建任务行（先于 assistant 消息落库）；
  // 假 runTask 不碰库，所以这里预置等价物——外键是真的，幻影 taskId 会红。
  // 会话行不在这里种：各用例自己建（新会话路径的 id 来自注入的 newId）。
  const tasks = new SqliteTaskRepository(d)
  tasks.insert({ id: 't-1', goal: '目标一', status: 'completed', createdAt: AT, updatedAt: AT })
  tasks.insert({ id: 't-2', goal: '目标二', status: 'failed', createdAt: AT, updatedAt: AT })
  return {
    conversations,
    messages,
    calls,
    // 默认替身：原样映射。编排不该加工历史的内容，裁剪是 buildHistory 的事。
    buildHistory: buildHistory ?? ((ms) => ms.map((m) => ({ role: m.role, text: m.text }))),
    runTask: async (goal, history) => {
      calls.push({ goal, history })
      return respond(goal, history)
    },
    now: () => NOW,
    newId: () => {
      idCounter += 1
      return `id-${idCounter}`
    }
  }
}

/** 预置一段已完成一轮的会话：u「第一问」→ a「第一答」（挂 t-0）。 */
function seedOneTurn(deps: SendMessageDeps): void {
  deps.conversations.insert({
    id: 'c-1',
    title: '已有会话',
    createdAt: AT,
    updatedAt: AT
  })
  deps.messages.append({
    id: 'm-0u',
    conversationId: 'c-1',
    role: 'user',
    text: '第一问',
    taskId: null,
    createdAt: AT
  })
  deps.messages.append({
    id: 'm-0a',
    conversationId: 'c-1',
    role: 'assistant',
    text: '第一答',
    taskId: 't-1',
    createdAt: AT
  })
}

describe('sendMessage 编排（TASK-032）', () => {
  it('新会话：建会话（标题 = 首条消息截断）、user 消息落库、runTask 收到 goal 与空历史', async () => {
    const deps = makeDeps(async () => completed())
    const long = '这是一条很长很长很长很长的消息标题用来验证截断是否生效'

    const result = await sendMessage({ conversationId: null, text: long }, deps)

    expect(result.ok).toBe(true)
    const conversation = deps.conversations.findById(result.conversationId)
    expect(conversation?.title).toBe(long.slice(0, 24) + '…')
    expect(conversation?.createdAt).toBe(NOW)
    expect(deps.calls[0]).toEqual({ goal: long, history: [] })
  })

  it('既有会话：消息进同一会话；buildHistory 收到本轮之前的消息（不含本轮）', async () => {
    const seen: MessageRecord[][] = []
    const deps = makeDeps(
      async () => completed(),
      (ms) => {
        seen.push([...ms])
        return ms.map((m) => ({ role: m.role, text: m.text }))
      }
    )
    seedOneTurn(deps)

    const result = await sendMessage({ conversationId: 'c-1', text: '第二问' }, deps)

    expect(result.conversationId).toBe('c-1')
    // 历史在「本轮 user 消息」之前取：本轮说什么由 goal 自己带，不重复进历史。
    expect(seen[0]?.map((m) => m.text)).toEqual(['第一问', '第一答'])
    expect(deps.calls[0]?.history).toEqual([
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '第一答' }
    ])
    const texts = deps.messages.listByConversation('c-1').map((m) => `${m.role}:${m.text}`)
    expect(texts).toEqual([
      'user:第一问',
      'assistant:第一答',
      'user:第二问',
      'assistant:已整理好，结论见下。'
    ])
  })

  it('completed：assistant 消息 = reply，挂 taskId，会话 touch 到本轮时间', async () => {
    const deps = makeDeps(async () => completed())
    const result = await sendMessage({ conversationId: null, text: '整理 PDF' }, deps)
    if (!result.ok) throw new Error('预期 ok:true')

    const messages = deps.messages.listByConversation(result.conversationId)
    const assistant = messages[messages.length - 1]
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.text).toBe('已整理好，结论见下。')
    expect(assistant?.taskId).toBe('t-1')
    expect(deps.conversations.findById(result.conversationId)?.updatedAt).toBe(NOW)
  })

  it('failed：assistant 消息 = reason，任务 id 仍挂上（执行留痕）', async () => {
    const deps = makeDeps(async () => failed())

    const result = await sendMessage({ conversationId: null, text: '整理 PDF' }, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe('failed')
    const messages = deps.messages.listByConversation(result.conversationId)
    const assistant = messages[messages.length - 1]
    expect(assistant?.text).toBe('预算耗尽：已用 12 步')
    expect(assistant?.taskId).toBe('t-2')
  })

  it('规划失败（ok:false）→ 原样透出，但会话仍留下 user 消息与承载失败的 assistant 消息', async () => {
    const deps = makeDeps(async () => planFailed())

    const result = await sendMessage({ conversationId: null, text: '整理 PDF' }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('PLAN_NOT_BUILDABLE')
    const messages = deps.messages.listByConversation(result.conversationId)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.text).toBe('计划没建出来')
    expect(messages[1]?.taskId).toBeNull()
  })

  it('会话不存在 → ok:false，不落任何消息', async () => {
    const deps = makeDeps(async () => completed())

    const result = await sendMessage({ conversationId: 'c-幻影', text: '你好' }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('PROTOCOL_INVALID_REQUEST')
    expect(result.message).toContain('c-幻影')
    expect(deps.messages.listByConversation('c-幻影')).toEqual([])
  })

  it('空 text（或非字符串）→ ok:false，不建会话不落消息', async () => {
    const deps = makeDeps(async () => completed())

    for (const bad of ['', '   ', 42, null]) {
      const result = await sendMessage({ conversationId: null, text: bad as string }, deps)
      expect(result.ok).toBe(false)
    }
    expect(deps.conversations.list()).toEqual([])
  })
})
