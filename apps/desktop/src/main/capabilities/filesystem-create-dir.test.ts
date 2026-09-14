import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ERROR_CODE, FilesystemCreateDirOutcome } from '@personal-agent/protocol'

import { createDir } from './filesystem-create-dir'
import { toPosix } from './roots'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-cd-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// createDir 吃的是 realpath 后的正斜杠绝对路径，测试用 toPosix 构造同款。
function target(...segs: string[]): string {
  return toPosix(join(dir, ...segs))
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

describe('createDir：新建', () => {
  it('不存在的目录 -> ok:true created:true，且目录真的建出来', async () => {
    const reading = target('Reading')
    const out = await createDir(reading)

    // 未实现占位返回 ok:false，这条会红——它是驱动你填函数体的主信号。
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.created).toBe(true)
      expect(out.path).toBe(reading)
    }
    expect(await isDir(reading)).toBe(true)
  })

  it('多层目录一次建成（recursive）', async () => {
    const deep = target('a', 'b', 'c')
    const out = await createDir(deep)

    expect(out.ok).toBe(true)
    expect(await isDir(deep)).toBe(true)
  })

  it('成功输出过 FilesystemCreateDirOutcome 契约', async () => {
    const out = await createDir(target('Reading'))
    // 先钉成功分支：fail 占位也能过 discriminatedUnion 的 failure 分支，
    // 不先断言 ok:true 就会假绿。
    expect(out.ok).toBe(true)
    expect(() => FilesystemCreateDirOutcome.parse(out)).not.toThrow()
  })
})

describe('createDir：幂等', () => {
  it('目录已存在 -> ok:true created:false，不报错', async () => {
    const reading = target('Reading')
    await mkdir(reading)

    const out = await createDir(reading)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.created).toBe(false)
      expect(out.path).toBe(reading)
    }
  })

  it('连续两次：第一次 created:true，第二次 created:false', async () => {
    const reading = target('Reading')
    const first = await createDir(reading)
    const second = await createDir(reading)

    expect(first.ok).toBe(true)
    if (first.ok) expect(first.created).toBe(true)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.created).toBe(false)
  })
})

describe('createDir：失败', () => {
  it('目标已存在同名文件 -> CREATE_DIR_FAILED，且不碰那个文件', async () => {
    const asFile = target('blocked')
    await writeFile(asFile, 'original')

    const out = await createDir(asFile)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe(ERROR_CODE.CREATE_DIR_FAILED)
    }
    // 在文件路径上建目录必须拒，且不能把它变成目录或删掉。
    expect(await isDir(asFile)).toBe(false)
  })

  it('失败输出过 CapabilityFailure 分支契约', async () => {
    const asFile = target('blocked')
    await writeFile(asFile, 'x')

    const out = await createDir(asFile)
    expect(out.ok).toBe(false)
    expect(() => FilesystemCreateDirOutcome.parse(out)).not.toThrow()
  })
})
