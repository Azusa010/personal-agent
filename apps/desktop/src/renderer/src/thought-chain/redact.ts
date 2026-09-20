const SENSITIVE_KEY_REGEX =
  /(password|token|secret|key|authorization|bearer|cookie|credential|private)/i
const API_KEY_PATTERN = /(?:sk-|Bearer\s+)[a-zA-Z0-9_-]{12,}/g
const JWT_PATTERN = /ey[a-zA-Z0-9_-]{16,}\.[a-zA-Z0-9_-]{16,}\.[a-zA-Z0-9_-]{16,}/g
const WIN_PATH_PATTERN = /([a-zA-Z]:\\[^:<>"|?*\n\r]+)/g

/**
 * 敏感数据脱敏纯函数：
 * 1. 递归扫描对象与数组（带 WeakSet 防循环引用）
 * 2. 识别敏感键名（password/token/key 等）并遮罩值
 * 3. 识别常见 API Key 与 JWT 字符串并打码（如 sk-1234***[REDACTED]）
 * 4. 规范化 Windows 绝对路径，隐藏多层个人目录（如 C:\...\file.txt）
 */
export function redactSensitiveData(data: unknown, seen = new WeakSet<object>()): unknown {
  if (data === null || data === undefined) return data

  if (typeof data === 'string') {
    let text = data
    text = text.replace(API_KEY_PATTERN, (match) => {
      const prefix = match.slice(0, 4)
      return `${prefix}***[REDACTED]`
    })
    text = text.replace(JWT_PATTERN, 'ey***[JWT_REDACTED]')
    text = text.replace(WIN_PATH_PATTERN, (fullPath) => {
      const parts = fullPath.split('\\')
      if (parts.length > 3) {
        return `${parts[0]}\\...\\${parts.slice(-2).join('\\')}`
      }
      return fullPath
    })
    return text
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return data
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, seen))
  }

  if (typeof data === 'object') {
    if (seen.has(data)) return '[Circular]'
    seen.add(data)

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(key) && typeof value === 'string' && value.length > 0) {
        result[key] = value.length > 6 ? `${value.slice(0, 3)}***[PROTECTED]` : '***[PROTECTED]'
      } else {
        result[key] = redactSensitiveData(value, seen)
      }
    }
    return result
  }

  return data
}
