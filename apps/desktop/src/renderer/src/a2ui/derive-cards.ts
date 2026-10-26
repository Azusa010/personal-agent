import { A2UIDocument } from '@personal-agent/protocol'
import type {
  A2UIRenderNotice,
  A2UIUpdateNotice,
  MessageView
} from '../../../shared/ipc-contract'

/**
 * A2UI 卡片视图模型（derive-cards）
 *
 * 卡片是消息流的一等成员：历史卡片从各消息 timeline 的 a2ui_* 事件按 seq 回放派生，
 * 活卡由 IPC notice 实时驱动，两者汇成同一形状 A2UICardView，live 优先覆盖历史。
 */

export const A2UI_RENDERED_EVENT = 'a2ui_rendered'
export const A2UI_UPDATED_EVENT = 'a2ui_updated'
export const A2UI_SUBMITTED_EVENT = 'a2ui_submitted'

export type A2UICardStatus = 'rendered' | 'submitted'

export interface A2UICardView {
  renderId: string
  taskId: string
  document: A2UIDocument
  /** 更新序号：首次 render 为 0，每次成功 update 递增 */
  version: number
  status: A2UICardStatus
  /** 首次渲染时刻：同任务多卡排序锚点 */
  firstSeenAt: string
  updatedAt: string
  /** 提交时刻用户所填：submitted 快照回显用 */
  submittedFormData?: Record<string, unknown>
}

export type A2UICardMap = Map<string, A2UICardView>

/** 宽容解析 document：旧版本落库的事件没有 document 字段（返回 null 跳过该卡） */
function asDocument(value: unknown): A2UIDocument | null {
  const parsed = A2UIDocument.safeParse(value)
  return parsed.success ? parsed.data : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 单条 timeline 事件应用到卡片表；返回是否发生了变化（新引用仅在变化时产生） */
function applyEvent(cards: A2UICardMap, type: string, payload: unknown, taskId: string, occurredAt: string): boolean {
  const record = asRecord(payload)
  const renderId = asString(record['renderId'])
  if (renderId === null) return false

  if (type === A2UI_RENDERED_EVENT) {
    const document = asDocument(record['document'])
    if (document === null) return false
    const existing = cards.get(renderId)
    if (existing !== undefined) return false
    cards.set(renderId, {
      renderId,
      taskId,
      document,
      version: 0,
      status: 'rendered',
      firstSeenAt: occurredAt,
      updatedAt: occurredAt
    })
    return true
  }

  if (type === A2UI_UPDATED_EVENT) {
    const card = cards.get(renderId)
    if (card === undefined || card.status !== 'rendered') return false
    const document = asDocument(record['document'])
    if (document === null) return false
    const version = record['version']
    cards.set(renderId, {
      ...card,
      document,
      version: typeof version === 'number' && Number.isFinite(version) ? version : card.version + 1,
      updatedAt: occurredAt
    })
    return true
  }

  if (type === A2UI_SUBMITTED_EVENT) {
    const card = cards.get(renderId)
    if (card === undefined || card.status === 'submitted') return false
    const rawFormData = record['formData']
    const formData =
      typeof rawFormData === 'object' && rawFormData !== null
        ? (rawFormData as Record<string, unknown>)
        : undefined
    cards.set(renderId, { ...card, status: 'submitted', updatedAt: occurredAt, submittedFormData: formData })
    return true
  }

  return false
}

/**
 * 从消息列表的 timeline 事件回放派生卡片表。
 * 每条消息的 events 已按 seq 升序（getConversation 投影保证）；
 * 事件缺 document（旧版本数据）时整卡跳过，不抛错。
 */
export function deriveCardsFromMessages(messages: MessageView[]): A2UICardMap {
  const cards: A2UICardMap = new Map()
  for (const message of messages) {
    if (message.timeline === null) continue
    const taskId = message.taskId ?? message.timeline.task.id
    for (const event of message.timeline.events) {
      applyEvent(cards, event.type, event.payload, taskId, event.occurredAt)
    }
  }
  return cards
}

/** 实时渲染通知：新卡进场（或覆盖历史派生的同 renderId 卡） */
export function applyRenderNotice(cards: A2UICardMap, notice: A2UIRenderNotice): A2UICardMap {
  const next = new Map(cards)
  next.set(notice.renderId, {
    renderId: notice.renderId,
    taskId: notice.taskId,
    document: notice.document,
    version: 0,
    status: 'rendered',
    firstSeenAt: notice.createdAt,
    updatedAt: notice.createdAt
  })
  return next
}

/** 实时更新通知：仅 rendered 状态的已存在卡片接受原地刷新 */
export function applyUpdateNotice(cards: A2UICardMap, notice: A2UIUpdateNotice): A2UICardMap {
  const card = cards.get(notice.renderId)
  if (card === undefined || card.status !== 'rendered') return cards
  const next = new Map(cards)
  next.set(notice.renderId, {
    ...card,
    document: notice.document,
    version: notice.version,
    updatedAt: notice.updatedAt
  })
  return next
}

/** 本地提交回执：提交成功后立即把活卡翻成已提交快照（事件库的 a2ui_submitted 随 loadConversation 兜底） */
export function applyLocalSubmit(
  cards: A2UICardMap,
  renderId: string,
  formData: Record<string, unknown>,
  submittedAt: string
): A2UICardMap {
  const card = cards.get(renderId)
  if (card === undefined || card.status === 'submitted') return cards
  const next = new Map(cards)
  next.set(renderId, { ...card, status: 'submitted', updatedAt: submittedAt, submittedFormData: { ...formData } })
  return next
}

/** 合并历史派生与实时卡片：live 同 renderId 覆盖历史 */
export function mergeCards(history: A2UICardMap, live: A2UICardMap): A2UICardMap {
  const merged = new Map(history)
  for (const [renderId, card] of live) {
    merged.set(renderId, card)
  }
  return merged
}

/** 过滤本会话内被用户手动关闭的卡片 */
export function filterDismissed(cards: A2UICardMap, dismissed: ReadonlySet<string>): A2UICardMap {
  if (dismissed.size === 0) return cards
  const kept = new Map(cards)
  for (const renderId of dismissed) {
    kept.delete(renderId)
  }
  return kept
}

/** 取某任务名下的卡片，按首次渲染时刻排序（同任务多卡的稳定顺序） */
export function cardsForTask(cards: A2UICardMap, taskId: string): A2UICardView[] {
  const list: A2UICardView[] = []
  for (const card of cards.values()) {
    if (card.taskId === taskId) list.push(card)
  }
  return list.sort((a, b) =>
    a.firstSeenAt === b.firstSeenAt
      ? a.renderId.localeCompare(b.renderId)
      : a.firstSeenAt.localeCompare(b.firstSeenAt)
  )
}
