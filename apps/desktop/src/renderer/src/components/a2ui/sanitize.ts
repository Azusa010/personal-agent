import { A2UIComponentType } from '@personal-agent/protocol'

/**
 * 校验组件类型是否处于受信任白名单中
 */
export function isAllowedComponentType(type: string): boolean {
  return (A2UIComponentType.options as readonly string[]).includes(type)
}

const PROHIBITED_PROP_KEYS = new Set(['dangerouslysetinnerhtml', 'innerhtml', 'outerhtml'])

const PROHIBITED_EVENT_REGEX = /^on[a-zA-Z]/i

/**
 * 净化组件属性，剥离 XSS 注入点及事件处理器属性
 */
export function sanitizeProps(props: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(props)) {
    const lowerKey = key.toLowerCase()

    // 1. 拦截并剥离所有 on* 事件属性 (如 onClick, onError, onLoad 等)
    if (PROHIBITED_EVENT_REGEX.test(key)) {
      continue
    }

    // 2. 拦截危险 HTML 注入属性
    if (PROHIBITED_PROP_KEYS.has(lowerKey)) {
      continue
    }

    // 3. 针对字符串值进行协议过滤
    if (typeof value === 'string') {
      const trimmed = value.trim().toLowerCase()
      if (trimmed.startsWith('javascript:') || trimmed.startsWith('vbscript:')) {
        continue
      }
      sanitized[key] = value
    } else {
      sanitized[key] = value
    }
  }

  return sanitized
}

const SAFE_IMAGE_PREFIXES = ['http://', 'https://', 'data:image/']

/**
 * 校验并净化图片地址，限制为本地受信任路径或受控协议
 */
export function sanitizeImageSrc(src: unknown): string | null {
  if (typeof src !== 'string') return null
  const trimmed = src.trim()
  if (!trimmed) return null

  const lower = trimmed.toLowerCase()
  if (lower.startsWith('javascript:') || lower.startsWith('data:text/html')) {
    return null
  }

  // 允许 HTTP/HTTPS 与安全图片 Data URI
  for (const prefix of SAFE_IMAGE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return trimmed
    }
  }

  // 允许相对路径（workspace/downloads/assets）
  if (!trimmed.includes('://') && !trimmed.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return trimmed
  }

  // 允许 app 自定义协议或安全的 file URL (非系统级敏感路径)
  if (lower.startsWith('file://') && !lower.includes('windows') && !lower.includes('system32')) {
    return trimmed
  }

  return null
}
