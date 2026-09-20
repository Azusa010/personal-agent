import { describe, expect, it } from 'vitest'
import { redactSensitiveData } from './redact'

describe('redactSensitiveData', () => {
  it('基本类型原样返回', () => {
    expect(redactSensitiveData(null)).toBeNull()
    expect(redactSensitiveData(undefined)).toBeUndefined()
    expect(redactSensitiveData(123)).toBe(123)
    expect(redactSensitiveData(true)).toBe(true)
  })

  it('脱敏 API Key 与 Bearer token', () => {
    const raw = 'Authorization: Bearer mySecretToken1234567890'
    const redacted = redactSensitiveData(raw) as string
    expect(redacted).toContain('Bear***[REDACTED]')

    const openai = 'Key is sk-abcdef1234567890abcdef'
    const redactedKey = redactSensitiveData(openai) as string
    expect(redactedKey).toContain('sk-a***[REDACTED]')
  })

  it('脱敏敏感对象键名', () => {
    const input = {
      apiKey: 'sk-9876543210fedcba',
      password: 'superSecretPassword',
      normalField: 'hello world'
    }
    const result = redactSensitiveData(input) as Record<string, unknown>
    expect(result.apiKey).toBe('sk-***[PROTECTED]')
    expect(result.password).toBe('sup***[PROTECTED]')
    expect(result.normalField).toBe('hello world')
  })

  it('脱敏 Windows 深层绝对路径', () => {
    const input = {
      path: 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\secret.txt'
    }
    const result = redactSensitiveData(input) as Record<string, unknown>
    expect(result.path).toBe('C:\\...\\Temp\\secret.txt')
  })

  it('防止循环引用栈溢出', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const result = redactSensitiveData(circular) as Record<string, unknown>
    expect(result.a).toBe(1)
    expect(result.self).toBe('[Circular]')
  })
})
