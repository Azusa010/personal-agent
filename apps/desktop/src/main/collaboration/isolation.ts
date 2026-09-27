/**
 * Multi-Agent / Subagent 消息隔离与防注入标头
 *
 * 依据《深入理解 AI Agent》第 4 章协作设计：
 * 主 Agent 与子 Agent 之间的通信必须具备强上下文隔离与标头封装。
 * 若外部输入（如文档内容、用户消息）中包含伪造的标头标签，
 * 必须在传递给子 Agent 前进行严格转义，防止子 Agent 被诱导越权或逃逸。
 */

export const SUBAGENT_MESSAGE_HEADER = '[FROM_MAIN_AGENT_START]'
export const SUBAGENT_MESSAGE_FOOTER = '[FROM_MAIN_AGENT_END]'
export const SUBAGENT_RESPONSE_HEADER = '[FROM_SUBAGENT_START]'
export const SUBAGENT_RESPONSE_FOOTER = '[FROM_SUBAGENT_END]'

const ESCAPED_PREFIX = '[ESCAPED:'
const ESCAPED_SUFFIX = ']'

const ISOLATION_TAGS = [
  SUBAGENT_MESSAGE_HEADER,
  SUBAGENT_MESSAGE_FOOTER,
  SUBAGENT_RESPONSE_HEADER,
  SUBAGENT_RESPONSE_FOOTER
] as const

/**
 * 对内容中的隔离标头进行防注入转义
 */
export function escapeIsolationTags(content: string): string {
  let escaped = content
  for (const tag of ISOLATION_TAGS) {
    const innerName = tag.slice(1, -1) // e.g. FROM_MAIN_AGENT_START
    const safeTag = `${ESCAPED_PREFIX}${innerName}${ESCAPED_SUFFIX}`
    escaped = escaped.replaceAll(tag, safeTag)
  }
  return escaped
}

/**
 * 还原被转义的隔离标头（仅在安全沙盒或审计时调用）
 */
export function unescapeIsolationTags(content: string): string {
  let unescaped = content
  for (const tag of ISOLATION_TAGS) {
    const innerName = tag.slice(1, -1)
    const safeTag = `${ESCAPED_PREFIX}${innerName}${ESCAPED_SUFFIX}`
    unescaped = unescaped.replaceAll(safeTag, tag)
  }
  return unescaped
}

export interface IsolationMeta {
  readonly parentTaskId?: string
  readonly subagentId?: string
  readonly role?: string
  readonly timestamp?: number
}

/**
 * 主 Agent 向子 Agent 发送消息时的隔离封装
 */
export function wrapMainToSubagentMessage(content: string, meta?: IsolationMeta): string {
  const sanitized = escapeIsolationTags(content)
  const metaHeader = meta ? `<!-- META: ${JSON.stringify(meta)} -->\n` : ''
  return `${SUBAGENT_MESSAGE_HEADER}\n${metaHeader}${sanitized}\n${SUBAGENT_MESSAGE_FOOTER}`
}

export interface UnwrappedMessage {
  readonly content: string
  readonly isValid: boolean
  readonly meta?: Record<string, unknown>
  readonly raw: string
}

/**
 * 解析并解包主 Agent 发送给子 Agent 的消息
 */
export function unwrapMainToSubagentMessage(raw: string): UnwrappedMessage {
  const trimmed = raw.trim()
  const startIndex = trimmed.indexOf(SUBAGENT_MESSAGE_HEADER)
  const endIndex = trimmed.lastIndexOf(SUBAGENT_MESSAGE_FOOTER)

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return {
      content: raw,
      isValid: false,
      raw
    }
  }

  const payload = trimmed.slice(startIndex + SUBAGENT_MESSAGE_HEADER.length, endIndex).trim()

  // 提取可选元数据注释
  const metaMatch = payload.match(/^<!-- META: (.*?) -->\n?/)
  let meta: Record<string, unknown> | undefined
  let cleanPayload = payload

  if (metaMatch && metaMatch[1]) {
    try {
      meta = JSON.parse(metaMatch[1])
      cleanPayload = payload.slice(metaMatch[0].length).trim()
    } catch {
      // ignore invalid json meta
    }
  }

  return {
    content: cleanPayload,
    isValid: true,
    meta,
    raw
  }
}

/**
 * 子 Agent 向主 Agent 返回消息时的隔离封装
 */
export function wrapSubagentToMainMessage(content: string, meta?: IsolationMeta): string {
  const sanitized = escapeIsolationTags(content)
  const metaHeader = meta ? `<!-- META: ${JSON.stringify(meta)} -->\n` : ''
  return `${SUBAGENT_RESPONSE_HEADER}\n${metaHeader}${sanitized}\n${SUBAGENT_RESPONSE_FOOTER}`
}

/**
 * 解析并解包子 Agent 返回给主 Agent 的响应
 */
export function unwrapSubagentToMainMessage(raw: string): UnwrappedMessage {
  const trimmed = raw.trim()
  const startIndex = trimmed.indexOf(SUBAGENT_RESPONSE_HEADER)
  const endIndex = trimmed.lastIndexOf(SUBAGENT_RESPONSE_FOOTER)

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return {
      content: raw,
      isValid: false,
      raw
    }
  }

  const payload = trimmed.slice(startIndex + SUBAGENT_RESPONSE_HEADER.length, endIndex).trim()

  const metaMatch = payload.match(/^<!-- META: (.*?) -->\n?/)
  let meta: Record<string, unknown> | undefined
  let cleanPayload = payload

  if (metaMatch && metaMatch[1]) {
    try {
      meta = JSON.parse(metaMatch[1])
      cleanPayload = payload.slice(metaMatch[0].length).trim()
    } catch {
      // ignore invalid json meta
    }
  }

  return {
    content: cleanPayload,
    isValid: true,
    meta,
    raw
  }
}
