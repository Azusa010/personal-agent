import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveWithinRootReal } from '../../../src/main/capabilities/path-guard'
import { toPosix } from '../../../src/main/capabilities/roots'

let dir: string
let realRoot: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-guard-enhanced-'))
  realRoot = toPosix(await realpath(dir))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('resolveWithinRootReal：Windows 保留设备名拦截 (PATH_DEVICE_NAME_FORBIDDEN)', () => {
  const RESERVED_NAMES = [
    'CON',
    'con',
    'PRN',
    'prn',
    'AUX',
    'aux',
    'NUL',
    'nul',
    'COM1',
    'com5',
    'COM9',
    'LPT1',
    'lpt4',
    'LPT9'
  ]

  for (const name of RESERVED_NAMES) {
    it(`顶层保留名 ${name} 必须被拦截`, async () => {
      const out = await resolveWithinRootReal(dir, join(dir, name))
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.code).toBe('PATH_DEVICE_NAME_FORBIDDEN')
        expect(out.reason).toContain('Windows 保留设备名')
      }
    })

    it(`带后缀的保留名 ${name}.txt 必须被拦截`, async () => {
      const out = await resolveWithinRootReal(dir, join(dir, `${name}.txt`))
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.code).toBe('PATH_DEVICE_NAME_FORBIDDEN')
        expect(out.reason).toContain('Windows 保留设备名')
      }
    })

    it(`深层子路径中的保留名 sub/${name}.pdf 必须被拦截`, async () => {
      const out = await resolveWithinRootReal(dir, join(dir, 'sub', `${name}.pdf`))
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.code).toBe('PATH_DEVICE_NAME_FORBIDDEN')
        expect(out.reason).toContain('Windows 保留设备名')
      }
    })
  }

  it('不应误杀包含保留词前缀的正常文件名 (如 contact.txt / auxiliary.js / prompt.md)', async () => {
    const validNames = ['contact.txt', 'auxiliary.js', 'prompt.md', 'nullify.ts', 'commander.log']
    for (const name of validNames) {
      const out = await resolveWithinRootReal(dir, join(dir, name))
      expect(out.ok).toBe(true)
      if (out.ok) {
        expect(out.path).toBe(`${realRoot}/${name}`)
      }
    }
  })
})

describe('resolveWithinRootReal：非法与控制字符拦截 (PATH_INVALID_CHAR)', () => {
  it('包含空字节 \\0 (Null Byte) 必须拦截为 PATH_INVALID_CHAR 而非崩溃', async () => {
    const out = await resolveWithinRootReal(dir, `${dir}/test\0.pdf`)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe('PATH_INVALID_CHAR')
      expect(out.reason).toContain('非法或控制字符')
    }
  })

  it('包含 ASCII 0x01-0x1f 控制字符必须拦截为 PATH_INVALID_CHAR', async () => {
    for (const code of [1, 7, 10, 13, 27, 31]) {
      const char = String.fromCharCode(code)
      const out = await resolveWithinRootReal(dir, `${dir}/bad${char}name.txt`)
      expect(out.ok, `char code: ${code}`).toBe(false)
      if (!out.ok) {
        expect(out.code).toBe('PATH_INVALID_CHAR')
      }
    }
  })

  it('文件名段中包含 Windows 禁用的特殊字符 (<, >, ", |, ?, *) 必须拦截为 PATH_INVALID_CHAR', async () => {
    const badChars = ['<', '>', '"', '|', '?', '*']
    for (const char of badChars) {
      const candidate = `${dir}/file${char}name.txt`
      const out = await resolveWithinRootReal(dir, candidate)
      expect(out.ok, `char: ${char}`).toBe(false)
      if (!out.ok) {
        expect(out.code).toBe('PATH_INVALID_CHAR')
      }
    }
  })
})
