import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { redactText, sanitizeContext } from '../../../src/main/observability/redactor'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(
  __dirname,
  '../../../../../packages/protocol/fixtures/logging/redaction-cases.json'
)

interface RedactionFixture {
  cases: Array<{ name: string; note?: string; input: string; expected: string }>
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RedactionFixture

describe('redactor ~ 共享 fixture（TS/Python 必须同解）', () => {
  for (const item of fixture.cases) {
    it(`${item.name}: ${item.note ?? '按规则表脱敏'}`, () => {
      expect(redactText(item.input)).toBe(item.expected)
    })
  }

  it('每条 fixture 的输出都不得再含原始密钥', () => {
    const secrets = [
      'abc123def456ghi789',
      'sk-abcdefghijklmnopqrstuvwx',
      'sk-proj-1234567890abcdefghijklmn',
      'hunter2secret',
      'ghp_1234567890abcdefghij'
    ]

    for (const item of fixture.cases) {
      const output = redactText(item.input)
      for (const secret of secrets) {
        expect(output.includes(secret), `${item.name} 泄漏了 ${secret}`).toBe(false)
      }
    }
  })
})

describe('redactor ~ 幂等与误伤', () => {
  it('重复脱敏结果不变', () => {
    for (const item of fixture.cases) {
      const once = redactText(item.input)
      expect(redactText(once)).toBe(once)
    }
  })

  it('不含敏感信息的文本原样返回', () => {
    const benign = '任务 42 在第 3 步失败，耗时 1200ms，重试 2 次'
    expect(redactText(benign)).toBe(benign)
  })

  it('空串与纯空白不崩', () => {
    expect(redactText('')).toBe('')
    expect(redactText('   ')).toBe('   ')
  })
})

describe('redactor ~ sanitizeContext', () => {
  it('undefined 输入返回 undefined', () => {
    expect(sanitizeContext(undefined)).toBeUndefined()
  })

  it('递归清洗嵌套字符串', () => {
    const cleaned = sanitizeContext({
      outer: 'token=ghp_1234567890abcdefghij',
      nested: { deeper: ['user m3171470760@gmail.com'] }
    }) as Record<string, unknown>

    expect(cleaned.outer).toBe('token=***')
    expect(JSON.stringify(cleaned)).not.toContain('ghp_')
    expect(JSON.stringify(cleaned)).not.toContain('m3171470760@gmail.com')
    expect(JSON.stringify(cleaned)).toContain('<email>')
  })

  it('超过深度上限的子树被标记而非继续递归', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too-deep' } } } } } }

    const cleaned = sanitizeContext(deep)

    expect(JSON.stringify(cleaned)).toContain('<depth-limit>')
  })

  it('数组超过 50 项截断', () => {
    const cleaned = sanitizeContext({ list: Array.from({ length: 80 }, (_, i) => i) }) as {
      list: number[]
    }

    expect(cleaned.list).toHaveLength(50)
    expect(cleaned.list[0]).toBe(0)
    expect(cleaned.list[49]).toBe(49)
  })

  it('超长字符串值截断到 512 并加省略号', () => {
    const cleaned = sanitizeContext({ blob: 'x'.repeat(600) }) as { blob: string }

    expect(cleaned.blob.length).toBe(512)
    expect(cleaned.blob.endsWith('…')).toBe(true)
  })

  it('Error 实例转成 name/message/stack 且 message 被脱敏', () => {
    const error = new Error('failed with api_key=sk-abcdefghijklmnopqrstuvwx')
    const cleaned = sanitizeContext({ cause: error }) as {
      cause: { name: string; message: string; stack?: string }
    }

    expect(cleaned.cause.name).toBe('Error')
    expect(cleaned.cause.message).toContain('api_key=***')
    expect(cleaned.cause.message).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })

  it('undefined 值的键被丢弃，null 与布尔保留', () => {
    const cleaned = sanitizeContext({
      dropped: undefined,
      keepNull: null,
      keepBool: false,
      keepNumber: 0
    }) as Record<string, unknown>

    expect('dropped' in cleaned).toBe(false)
    expect(cleaned.keepNull).toBeNull()
    expect(cleaned.keepBool).toBe(false)
    expect(cleaned.keepNumber).toBe(0)
  })

  it('循环引用不导致栈溢出', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic

    const cleaned = sanitizeContext(cyclic)

    expect(JSON.stringify(cleaned)).toContain('<circular>')
  })

  it('函数与 Symbol 值转成占位符而不是崩溃', () => {
    const cleaned = sanitizeContext({
      fn: () => 1,
      sym: Symbol('x'),
      big: BigInt(10)
    }) as Record<string, unknown>

    expect(cleaned.fn).toBe('<unsupported>')
    expect(cleaned.sym).toBe('<unsupported>')
    expect(cleaned.big).toBe('<unsupported>')
  })
})
