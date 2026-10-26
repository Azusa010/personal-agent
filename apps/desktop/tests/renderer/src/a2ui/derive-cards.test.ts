import { describe, expect, it } from 'vitest'
import type { A2UIDocument } from '@personal-agent/protocol'
import type { MessageView } from '../../../../src/shared/ipc-contract'
import type { A2UIRenderNotice, A2UIUpdateNotice } from '../../../../src/shared/ipc-contract'
import {
  applyLocalSubmit,
  applyRenderNotice,
  applyUpdateNotice,
  cardsForTask,
  deriveCardsFromMessages,
  filterDismissed,
  mergeCards,
  type A2UICardMap
} from '../../../../src/renderer/src/a2ui/derive-cards'

function doc(text: string): A2UIDocument {
  return {
    version: '1.0',
    title: '任务进度',
    components: [
      { type: 'heading', id: 'progress-heading', props: { text, level: 3 } },
      { type: 'text_input', id: 'scope', props: { label: '范围', default: 'src/api/' } }
    ]
  }
}

function event(
  seq: number,
  taskId: string,
  type: string,
  payload: unknown,
  occurredAt: string
): { seq: number; taskId: string; type: string; payload: unknown; occurredAt: string } {
  return { seq, taskId, type, payload, occurredAt }
}

function message(
  seq: number,
  taskId: string | null,
  events: Array<ReturnType<typeof event>>
): MessageView {
  return {
    seq,
    id: `msg-${seq}`,
    role: 'assistant',
    text: '回复正文',
    taskId,
    createdAt: '2026-10-25T15:00:03.000Z',
    timeline:
      taskId === null
        ? null
        : {
            task: {
              id: taskId,
              goal: '盯进度',
              status: 'completed',
              createdAt: '2026-10-25T15:00:00.000Z',
              updatedAt: '2026-10-25T15:00:03.000Z'
            },
            plan: null,
            events
          }
  }
}

describe('derive-cards：历史回放派生', () => {
  it('rendered → updated×2 → submitted 全链路：取最后 document、version 递增、携带所填数据', () => {
    const taskId = 'task-a'
    const messages = [
      message(2, taskId, [
        event(1, taskId, 'a2ui_rendered', { renderId: 'r1', document: doc('0/2') }, '2026-10-25T15:00:00.000Z'),
        event(2, taskId, 'a2ui_updated', { renderId: 'r1', version: 1, document: doc('1/2') }, '2026-10-25T15:00:01.000Z'),
        event(3, taskId, 'a2ui_updated', { renderId: 'r1', version: 2, document: doc('2/2') }, '2026-10-25T15:00:02.000Z'),
        event(4, taskId, 'a2ui_submitted', { renderId: 'r1', actionId: 'submit', formData: { scope: 'src/core/' } }, '2026-10-25T15:00:03.000Z')
      ])
    ]

    const cards = deriveCardsFromMessages(messages)
    expect(cards.size).toBe(1)
    const card = cards.get('r1')
    expect(card).toMatchObject({
      renderId: 'r1',
      taskId,
      version: 2,
      status: 'submitted',
      firstSeenAt: '2026-10-25T15:00:00.000Z',
      submittedFormData: { scope: 'src/core/' }
    })
    expect(card?.document.components[0]?.props?.text).toBe('2/2')
  })

  it('旧版本事件（payload 无 document）整卡跳过，不抛错不产空卡', () => {
    const taskId = 'task-old'
    const messages = [
      message(2, taskId, [
        event(1, taskId, 'a2ui_rendered', { renderId: 'r-old', title: '只有摘要没有文档' }, '2026-10-01T00:00:00.000Z')
      ])
    ]
    expect(deriveCardsFromMessages(messages).size).toBe(0)
  })

  it('孤儿 updated/submitted 事件（无前置 rendered）被忽略', () => {
    const taskId = 'task-orphan'
    const messages = [
      message(2, taskId, [
        event(1, taskId, 'a2ui_updated', { renderId: 'r-x', version: 1, document: doc('1/2') }, '2026-10-25T15:00:01.000Z'),
        event(2, taskId, 'a2ui_submitted', { renderId: 'r-x', actionId: 'submit', formData: {} }, '2026-10-25T15:00:02.000Z')
      ])
    ]
    expect(deriveCardsFromMessages(messages).size).toBe(0)
  })

  it('submitted 之后的迟到 updated 不再生效（快照冻结）', () => {
    const taskId = 'task-frozen'
    const messages = [
      message(2, taskId, [
        event(1, taskId, 'a2ui_rendered', { renderId: 'r1', document: doc('0/2') }, '2026-10-25T15:00:00.000Z'),
        event(2, taskId, 'a2ui_submitted', { renderId: 'r1', actionId: 'submit', formData: {} }, '2026-10-25T15:00:01.000Z'),
        event(3, taskId, 'a2ui_updated', { renderId: 'r1', version: 1, document: doc('迟到') }, '2026-10-25T15:00:02.000Z')
      ])
    ]
    const card = deriveCardsFromMessages(messages).get('r1')
    expect(card?.status).toBe('submitted')
    expect(card?.document.components[0]?.props?.text).toBe('0/2')
  })

  it('多任务多卡归属：按消息 taskId 正确分桶', () => {
    const messages = [
      message(2, 'task-a', [
        event(1, 'task-a', 'a2ui_rendered', { renderId: 'ra-1', document: doc('A1') }, '2026-10-25T15:00:00.000Z')
      ]),
      message(4, 'task-b', [
        event(2, 'task-b', 'a2ui_rendered', { renderId: 'rb-1', document: doc('B1') }, '2026-10-25T15:01:00.000Z'),
        event(3, 'task-b', 'a2ui_rendered', { renderId: 'rb-2', document: doc('B2') }, '2026-10-25T15:00:30.000Z')
      ])
    ]
    const cards = deriveCardsFromMessages(messages)
    expect(cards.size).toBe(3)
    expect(cards.get('ra-1')?.taskId).toBe('task-a')
    expect(cards.get('rb-1')?.taskId).toBe('task-b')
    // cardsForTask：同任务按 firstSeenAt 排序（rb-2 早于 rb-1）
    const taskBCards = cardsForTask(cards, 'task-b')
    expect(taskBCards.map((c) => c.renderId)).toEqual(['rb-2', 'rb-1'])
  })

  it('消息 taskId 为 null 时回退 timeline.task.id 归属', () => {
    // 手工构造：message.taskId 为 null 但 timeline.task.id 存在（历史脏数据形态）
    const msg: MessageView = {
      seq: 2,
      id: 'msg-2',
      role: 'assistant',
      text: '回复正文',
      taskId: null,
      createdAt: '2026-10-25T15:00:03.000Z',
      timeline: {
        task: {
          id: 'task-fallback',
          goal: '盯进度',
          status: 'completed',
          createdAt: '2026-10-25T15:00:00.000Z',
          updatedAt: '2026-10-25T15:00:03.000Z'
        },
        plan: null,
        events: [
          event(1, 'task-fallback', 'a2ui_rendered', { renderId: 'r-fb', document: doc('FB') }, '2026-10-25T15:00:00.000Z')
        ]
      }
    }
    const cards = deriveCardsFromMessages([msg])
    expect(cards.get('r-fb')?.taskId).toBe('task-fallback')
  })
})

describe('derive-cards：实时通知 reducer', () => {
  const baseNotice: A2UIRenderNotice = {
    renderId: 'r-live',
    taskId: 'task-live',
    callId: 'call-1',
    document: doc('live 0'),
    createdAt: '2026-10-25T15:00:00.000Z'
  }

  it('applyRenderNotice 建卡；applyUpdateNotice 原地刷新 document 与 version', () => {
    let cards: A2UICardMap = new Map()
    cards = applyRenderNotice(cards, baseNotice)
    expect(cards.get('r-live')).toMatchObject({ version: 0, status: 'rendered' })

    const update: A2UIUpdateNotice = {
      renderId: 'r-live',
      taskId: 'task-live',
      callId: 'call-2',
      document: doc('live 1'),
      version: 1,
      updatedAt: '2026-10-25T15:00:05.000Z'
    }
    cards = applyUpdateNotice(cards, update)
    expect(cards.get('r-live')).toMatchObject({ version: 1, status: 'rendered' })
    expect(cards.get('r-live')?.document.components[0]?.props?.text).toBe('live 1')
  })

  it('applyUpdateNotice 忽略不存在的卡与已提交的卡', () => {
    const update: A2UIUpdateNotice = {
      renderId: 'r-missing',
      taskId: 'task-live',
      callId: 'call-2',
      document: doc('x'),
      version: 1,
      updatedAt: '2026-10-25T15:00:05.000Z'
    }
    let cards: A2UICardMap = new Map()
    expect(applyUpdateNotice(cards, update)).toBe(cards) // 无变化返回原引用

    cards = applyRenderNotice(cards, baseNotice)
    const submitted = applyLocalSubmit(cards, 'r-live', { scope: 'a' }, '2026-10-25T15:00:06.000Z')
    const frozen = applyUpdateNotice(submitted, {
      ...update,
      renderId: 'r-live'
    })
    expect(frozen.get('r-live')?.status).toBe('submitted')
    expect(frozen.get('r-live')?.document.components[0]?.props?.text).toBe('live 0')
  })

  it('applyLocalSubmit 翻转状态并携带所填数据；重复提交幂等', () => {
    let cards: A2UICardMap = applyRenderNotice(new Map(), baseNotice)
    cards = applyLocalSubmit(cards, 'r-live', { scope: 'src/core/' }, '2026-10-25T15:00:06.000Z')
    expect(cards.get('r-live')).toMatchObject({
      status: 'submitted',
      submittedFormData: { scope: 'src/core/' }
    })
    const again = applyLocalSubmit(cards, 'r-live', { scope: '别的' }, '2026-10-25T15:00:07.000Z')
    expect(again).toBe(cards) // 已提交：原引用返回
  })
})

describe('derive-cards：合并与过滤', () => {
  it('mergeCards：live 同 renderId 覆盖历史派生', () => {
    const history = deriveCardsFromMessages([
      message(2, 'task-a', [
        event(1, 'task-a', 'a2ui_rendered', { renderId: 'r1', document: doc('历史 v0') }, '2026-10-25T15:00:00.000Z'),
        event(2, 'task-a', 'a2ui_updated', { renderId: 'r1', version: 3, document: doc('历史 v3') }, '2026-10-25T15:00:01.000Z')
      ])
    ])
    const live = applyRenderNotice(new Map(), {
      renderId: 'r1',
      taskId: 'task-a',
      callId: 'call-9',
      document: doc('实时 v0'),
      createdAt: '2026-10-25T15:00:02.000Z'
    })
    const merged = mergeCards(history, live)
    expect(merged.size).toBe(1)
    expect(merged.get('r1')?.document.components[0]?.props?.text).toBe('实时 v0')
    expect(merged.get('r1')?.version).toBe(0)
  })

  it('filterDismissed：剔除被关闭的 renderId；空集合原引用返回', () => {
    const cards = applyRenderNotice(new Map(), {
      renderId: 'r1',
      taskId: 'task-a',
      callId: 'call-1',
      document: doc('x'),
      createdAt: '2026-10-25T15:00:00.000Z'
    })
    expect(filterDismissed(cards, new Set())).toBe(cards)
    const filtered = filterDismissed(cards, new Set(['r1']))
    expect(filtered.size).toBe(0)
  })
})
