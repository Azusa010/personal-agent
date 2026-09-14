import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ERROR_CODE, FilesystemMoveOutcome } from '@personal-agent/protocol'

import { moveFile } from './filesystem-move'
import { toPosix } from './roots'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-mv-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function p(...segs: string[]): string {
  return toPosix(join(dir, ...segs))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('moveFile：正常移动', () => {
  it('source 存在、target 不存在 -> ok:true，文件搬到 target', async () => {
    const source = p('report.pdf')
    const target = p('Reading', 'report.pdf')
    await writeFile(source, 'PDF-BYTES')
    await mkdir(p('Reading'))

    // 未实现占位返回 MOVE_FAILED，这条会红——驱动你填函数体的主信号。
    const out = await moveFile(source, target)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.source).toBe(source)
      expect(out.target).toBe(target)
    }
    // source 消失、target 出现且内容一致，才算真的移动了。
    expect(await exists(source)).toBe(false)
    expect(await readFile(target, 'utf-8')).toBe('PDF-BYTES')
  })

  it('成功输出过 FilesystemMoveOutcome 契约', async () => {
    const source = p('a.pdf')
    const target = p('sub', 'a.pdf')
    await writeFile(source, 'x')
    await mkdir(p('sub'))

    const out = await moveFile(source, target)
    expect(out.ok).toBe(true)
    expect(() => FilesystemMoveOutcome.parse(out)).not.toThrow()
  })
})

describe('moveFile：source 缺失', () => {
  it('source 不存在 -> MOVE_SOURCE_MISSING', async () => {
    const out = await moveFile(p('ghost.pdf'), p('Reading', 'ghost.pdf'))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe(ERROR_CODE.MOVE_SOURCE_MISSING)
    }
  })
})

describe('moveFile：target 已存在（拒绝覆盖）', () => {
  it('target 已有文件 -> MOVE_TARGET_EXISTS，source 和 target 都不动', async () => {
    const source = p('new.pdf')
    const target = p('existing.pdf')
    await writeFile(source, 'NEW')
    await writeFile(target, 'OLD')

    const out = await moveFile(source, target)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe(ERROR_CODE.MOVE_TARGET_EXISTS)
    }
    // 拒绝覆盖的两条硬证据：source 还在原地，target 内容仍是 OLD。
    expect(await readFile(source, 'utf-8')).toBe('NEW')
    expect(await readFile(target, 'utf-8')).toBe('OLD')
  })

  it('source===target -> MOVE_TARGET_EXISTS（target 就是已存在的 source）', async () => {
    const same = p('self.pdf')
    await writeFile(same, 'SELF')

    const out = await moveFile(same, same)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe(ERROR_CODE.MOVE_TARGET_EXISTS)
    }
    expect(await readFile(same, 'utf-8')).toBe('SELF')
  })
})

describe('moveFile：rename 失败', () => {
  it('target 父目录不存在 -> MOVE_FAILED，且不丢 source', async () => {
    const source = p('a.pdf')
    await writeFile(source, 'x')
    // 故意不建 Reading，直接移到 Reading/a.pdf：rename 会 ENOENT。
    const out = await moveFile(source, p('Reading', 'a.pdf'))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe(ERROR_CODE.MOVE_FAILED)
    }
    expect(await exists(source)).toBe(true)
  })
})
