import { describe, it, expect } from 'vitest'
import type { MessageRecord } from '../../shared/domain'
import { buildHistory, type HistoryBudget } from './history'

const AT = '2026-09-17T09:00:00.000Z'
const BUDGET: HistoryBudget = { maxMessages: 10, maxChars: 1000 }

function message(seq: number, role: 'user' | 'assistant', text: string): MessageRecord {
  return {
    seq,
    id: `m-${seq}`,
    conversationId: 'c-1',
    role,
    text,
    taskId: role === 'assistant' ? `t-${seq}` : null,
    createdAt: AT
  }
}

/** 交替的 u/a 序列，seq 从 1 起。 */
function conversationOf(texts: Array<[('user' | 'assistant'), string]>): MessageRecord[] {
  return texts.map(([role, text], i) => message(i + 1, role, text))
}

describe('buildHistory（陪练点：TODO(你填)[边界与异常]）', () => {
  it('空消息 → 空历史（第一轮）', () => {
    expect(buildHistory([], BUDGET)).toEqual([])
  })

  it('预算充足 → 全部按 seq 升序映射，Turn 只有 role 与 text（taskId 不进 wire）', () => {
    const messages = conversationOf([
      ['user', '第一问'],
      ['assistant', '第一答'],
      ['user', '第二问']
    ])

    expect(buildHistory(messages, BUDGET)).toEqual([
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '第一答' },
      { role: 'user', text: '第二问' }
    ])
  })

  it('maxMessages 截断：从最新往回留，顺序保持旧→新', () => {
    const messages = conversationOf([
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u2'],
      ['assistant', 'a2'],
      ['user', 'u3']
    ])

    const got = buildHistory(messages, { maxMessages: 3, maxChars: 1000 })

    expect(got.map((t) => t.text)).toEqual(['u2', 'a2', 'u3'])
  })

  it('裁完以 assistant 开头 → 继续丢到 user 开头（孤答没有可追溯的问题）', () => {
    const messages = conversationOf([
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u2'],
      ['assistant', 'a2']
    ])
    // 最近三条是 [a1, u2, a2]：a1 的提问被预算切掉了，把它一起丢掉。

    const got = buildHistory(messages, { maxMessages: 3, maxChars: 1000 })

    expect(got.map((t) => t.text)).toEqual(['u2', 'a2'])
  })

  it('maxChars 截断：放得下就取，放不下就停（只算 text，不算 role 标记）', () => {
    const long = '字'.repeat(40)
    const messages = conversationOf([
      ['user', long],
      ['assistant', long],
      ['user', long],
      ['assistant', long]
    ])

    // 从最新回溯：40 + 40 = 80 ≤ 100 取两条；再往前 40 就到 120 > 100，停。
    const got = buildHistory(messages, { maxMessages: 10, maxChars: 100 })

    expect(got.map((t) => t.text)).toEqual([long, long])
    expect(got[0]?.role).toBe('user')
  })

  it('正好等于预算 → 全取；差一个字符 → 丢到只剩 user 开头为止', () => {
    const messages = conversationOf([
      ['user', '字'.repeat(50)],
      ['assistant', '字'.repeat(50)]
    ])

    expect(buildHistory(messages, { maxMessages: 10, maxChars: 100 })).toHaveLength(2)
    // 99 只放得下 assistant 那条，但它开头不合法 → 继续丢 → 空历史。
    expect(buildHistory(messages, { maxMessages: 10, maxChars: 99 })).toEqual([])
  })

  it('一条都放不下 → 空数组（不抛错：这是纯函数，任何输入都有合法输出）', () => {
    const messages = conversationOf([['user', '字'.repeat(2000)]])

    expect(buildHistory(messages, { maxMessages: 10, maxChars: 100 })).toEqual([])
  })

  it('纯函数：不改入参数组', () => {
    const messages = conversationOf([
      ['user', '第一问'],
      ['assistant', '第一答']
    ])
    const before = messages.map((m) => ({ ...m }))

    buildHistory(messages, BUDGET)

    expect(messages).toEqual(before)
  })
})