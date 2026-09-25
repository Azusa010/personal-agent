import type { UserMemoryCard } from '@personal-agent/protocol'

export const WORKING_MEMORY_HEADER =
  '[用户常驻工作记忆 - 以下为用户长期特征、偏好与已知事实，作为基础上下文]'
export const WORKING_MEMORY_FOOTER = '[常驻记忆结束]'

export const CATEGORY_TAG_MAP: Record<string, string> = {
  identity: '身份画像',
  preference: '个人偏好',
  routine: '流程惯例',
  event: '重要情景',
  skill: '技能经验',
  general: '通用事实',
  relationship: '人际关系',
  work: '工作背景'
}

/** 规则策略接口：基于策略模式扩展 User as Code 规则。 */
export interface UserRuleStrategy {
  name: string
  detect: (cards: UserMemoryCard[], now: Date) => string | null
}

/**
 * 事实格式化辅助函数：将 Card 转换为一行易读文本
 */
export function formatSingleMemoryLine(card: UserMemoryCard): string {
  const tag = CATEGORY_TAG_MAP[card.category] || card.category
  const contentStr =
    typeof card.content === 'object' && card.content !== null
      ? Object.entries(card.content)
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
          .join(', ')
      : String(card.content)

  let line = `- [${tag}] ${card.subject}: ${contentStr}`
  if (card.person && card.person !== '本人') {
    line += ` (关联人: ${card.person})`
  }
  return line
}

/**
 * 按同一实体与主题 (person + subject) 进行时效去重选优，保留最新有效事实。
 */
export function deduplicateLatestMemories(memories: UserMemoryCard[]): UserMemoryCard[] {
  const map = new Map<string, UserMemoryCard>()

  // 按时间降序排序：最新发生的排在前面
  const sorted = [...memories].sort((a, b) => {
    const timeA = new Date(a.occurredAt || a.createdAt).getTime()
    const timeB = new Date(b.occurredAt || b.createdAt).getTime()
    return timeB - timeA
  })

  for (const card of sorted) {
    const key = `${card.person || '本人'}::${card.subject}`
    if (!map.has(key)) {
      map.set(key, card)
    }
  }

  return Array.from(map.values())
}

/**
 * 将用户活跃卡片按三类配额与预算截断，格式化为注入 Prompt 的常驻工作记忆文本。
 */
export function formatActiveMemoriesForPrompt(memories: UserMemoryCard[], maxChars = 1800): string {

  if (memories.length === 0) return ''

  const deduped = deduplicateLatestMemories(memories)
  const lines = deduped.map(formatSingleMemoryLine)
  const body = lines.join('\n').slice(0, maxChars)
  return `${WORKING_MEMORY_HEADER}\n${body}\n${WORKING_MEMORY_FOOTER}`
}

/**
 * 预设规则 1：护照/重要证件临期预警策略
 */
export const passportExpiryRule: UserRuleStrategy = {
  name: 'passport_expiry_rule',
  detect: (cards, now) => {
    for (const card of cards) {
      if (card.subject.includes('护照') || card.subject.includes('签证')) {
        const contentStr = JSON.stringify(card.content)
        const match = /(\d{4}-\d{2}-\d{2})/.exec(contentStr)
        if (match) {
          const expiry = new Date(match[1])
          const diffDays = (expiry.getTime() - now.getTime()) / (1000 * 3600 * 24)
          if (diffDays > 0 && diffDays <= 180) {
            return `[系统主动约束提示: 注意，用户护照将于 ${match[1]} 到期（不足 6 个月），若涉及出境行程请主动提醒]`
          }
        }
      }
    }
    return null
  }
}

/**
 * 预设规则 2：食物过敏与饮食禁忌预警策略
 */
export const allergyAlertRule: UserRuleStrategy = {
  name: 'allergy_alert_rule',
  detect: (cards) => {
    for (const card of cards) {
      const fullText = `${card.subject} ${JSON.stringify(card.content)}`
      if (fullText.includes('过敏') || fullText.includes('忌口')) {
        return `[系统主动偏好提示: 检测到用户存在重要饮食偏好或过敏记录 (${card.subject})，涉及餐饮或采购安排时必须规避]`
      }
    }
    return null
  }
}

export const DEFAULT_USER_RULES: readonly UserRuleStrategy[] = [
  passportExpiryRule,
  allergyAlertRule
]

/**
 * User as Code 确定性规则预警探测器 (轻量级主动服务)。
 */
export function detectUserAsCodeAlerts(
  memories: UserMemoryCard[],
  now: Date = new Date(),
  rules: readonly UserRuleStrategy[] = DEFAULT_USER_RULES
): string[] {
  const alerts: string[] = []
  for (const rule of rules) {
    const alert = rule.detect(memories, now)
    if (alert) {
      alerts.push(alert)
    }
  }
  return alerts
}

/**
 * 装配完整的工作记忆 Prompt（常驻事实 + 主动服务提示）
 */
export function assembleWorkingMemoryPrompt(
  memories: UserMemoryCard[],
  now: Date = new Date(),
  maxChars = 1800
): string {
  const memoryBlock = formatActiveMemoriesForPrompt(memories, maxChars)
  const alerts = detectUserAsCodeAlerts(memories, now)

  if (!memoryBlock && alerts.length === 0) {
    return ''
  }

  const parts: string[] = []
  if (memoryBlock) {
    parts.push(memoryBlock)
  }
  if (alerts.length > 0) {
    parts.push(alerts.join('\n'))
  }

  return parts.join('\n\n')
}
