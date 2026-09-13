import { describe, it, expect } from 'vitest'
import type { BoundArgs } from '../policy/argument-binders'
import { effectiveArgs, fingerprintArguments, sha256Hex } from './args-hash'

describe('sha256Hex', () => {
  it('标准向量：空串与 abc', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('输出是 64 位小写十六进制', () => {
    expect(sha256Hex('{"rootId":"downloads"}')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('effectiveArgs', () => {
  it('paths 覆盖同名的 args 键，执行体读的是规范化值', () => {
    const bound: BoundArgs = {
      args: { path: 'D:\\downloads\\a.pdf' },
      paths: { path: 'D:/downloads/a.pdf' }
    }
    expect(effectiveArgs(bound)).toEqual({ path: 'D:/downloads/a.pdf' })
  })

  it('没有路径的能力原样透传 args', () => {
    const bound: BoundArgs = { args: { rootId: 'downloads' }, paths: {} }
    expect(effectiveArgs(bound)).toEqual({ rootId: 'downloads' })
  })

  it('多个路径字段各自覆盖', () => {
    const bound: BoundArgs = {
      args: { source: 'D:\\downloads\\a.pdf', target: 'D:\\downloads\\Reading\\a.pdf' },
      paths: {
        source: 'D:/downloads/a.pdf',
        target: 'D:/downloads/Reading/a.pdf'
      }
    }
    expect(effectiveArgs(bound)).toEqual({
      source: 'D:/downloads/a.pdf',
      target: 'D:/downloads/Reading/a.pdf'
    })
  })
})

describe('fingerprintArguments：同值同 Hash', () => {
  it('同一个文件的两种写法算出同一个 Hash', () => {
    // 模型给反斜杠还是正斜杠，规范化之后都是同一个 realpath
    const windowsStyle: BoundArgs = {
      args: { path: 'D:\\downloads\\a.pdf' },
      paths: { path: 'D:/downloads/a.pdf' }
    }
    const posixStyle: BoundArgs = {
      args: { path: 'D:/downloads/a.pdf' },
      paths: { path: 'D:/downloads/a.pdf' }
    }
    expect(fingerprintArguments(windowsStyle).hash).toBe(fingerprintArguments(posixStyle).hash)
  })

  it('非路径字段的键序不影响 Hash', () => {
    const a: BoundArgs = {
      args: { rootId: 'downloads', overwrite: true, limit: 10 },
      paths: {}
    }
    const b: BoundArgs = {
      args: { limit: 10, overwrite: true, rootId: 'downloads' },
      paths: {}
    }
    expect(fingerprintArguments(a).hash).toBe(fingerprintArguments(b).hash)
  })

  it('同一个 BoundArgs 调两次结果一样', () => {
    const bound: BoundArgs = { args: { rootId: 'downloads' }, paths: {} }
    expect(fingerprintArguments(bound)).toEqual(fingerprintArguments(bound))
  })

  it('Hash 就是 canonical 串的 sha256，两者不会各算一套', () => {
    const bound: BoundArgs = { args: { rootId: 'downloads' }, paths: {} }
    const fingerprint = fingerprintArguments(bound)
    expect(fingerprint.hash).toBe(sha256Hex(fingerprint.canonical))
  })
})

describe('fingerprintArguments：任一参数变化 Hash 不同', () => {
  const base: BoundArgs = {
    args: { source: 'a.pdf', target: 'Reading/a.pdf', overwrite: false },
    paths: {
      source: 'D:/downloads/a.pdf',
      target: 'D:/downloads/Reading/a.pdf'
    }
  }

  it('换一个来源路径', () => {
    const changed: BoundArgs = {
      ...base,
      paths: { ...base.paths, source: 'D:/downloads/b.pdf' }
    }
    expect(fingerprintArguments(changed).hash).not.toBe(fingerprintArguments(base).hash)
  })

  it('换一个目标路径', () => {
    const changed: BoundArgs = {
      ...base,
      paths: { ...base.paths, target: 'D:/downloads/Archive/a.pdf' }
    }
    expect(fingerprintArguments(changed).hash).not.toBe(fingerprintArguments(base).hash)
  })

  it('翻转一个布尔参数', () => {
    const changed: BoundArgs = { ...base, args: { ...base.args, overwrite: true } }
    expect(fingerprintArguments(changed).hash).not.toBe(fingerprintArguments(base).hash)
  })

  it('多一个参数', () => {
    const changed: BoundArgs = { ...base, args: { ...base.args, dryRun: true } }
    expect(fingerprintArguments(changed).hash).not.toBe(fingerprintArguments(base).hash)
  })

  it('少一个参数', () => {
    const changed: BoundArgs = {
      args: { source: 'a.pdf', target: 'Reading/a.pdf' },
      paths: base.paths
    }
    expect(fingerprintArguments(changed).hash).not.toBe(fingerprintArguments(base).hash)
  })

  it('source 与 target 互换算不同的 Hash', () => {
    const swapped: BoundArgs = {
      args: { source: 'Reading/a.pdf', target: 'a.pdf', overwrite: false },
      paths: {
        source: 'D:/downloads/Reading/a.pdf',
        target: 'D:/downloads/a.pdf'
      }
    }
    expect(fingerprintArguments(swapped).hash).not.toBe(fingerprintArguments(base).hash)
  })

  it('数字 10 与字符串 "10" 算不同的 Hash', () => {
    const numeric: BoundArgs = { args: { limit: 10 }, paths: {} }
    const textual: BoundArgs = { args: { limit: '10' }, paths: {} }
    expect(fingerprintArguments(numeric).hash).not.toBe(fingerprintArguments(textual).hash)
  })
})

describe('fingerprintArguments：canonical 串', () => {
  it('就是 Permission Contract 要展示的规范化参数摘要，能被 JSON.parse 回原值', () => {
    const bound: BoundArgs = {
      args: { source: 'D:\\downloads\\a.pdf', overwrite: false },
      paths: { source: 'D:/downloads/a.pdf' }
    }
    const { canonical } = fingerprintArguments(bound)
    expect(canonical).toBe('{"overwrite":false,"source":"D:/downloads/a.pdf"}')
    expect(JSON.parse(canonical)).toEqual(effectiveArgs(bound))
  })
})
