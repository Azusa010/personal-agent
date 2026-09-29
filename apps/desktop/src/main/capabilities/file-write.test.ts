import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeFileAtomic } from './file-write'

describe('file-write: writeFileAtomic', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-test-file-write-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('成功写入文本文件并返回精确字节数', async () => {
    const target = join(tempDir, 'output.txt')
    const content = 'hello world'
    const outcome = await writeFileAtomic(target, content)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.path).toBe(target)
      expect(outcome.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'))
    }

    const written = await readFile(target, 'utf8')
    expect(written).toBe(content)
  })

  it('自动创建深层嵌套的不存在父目录', async () => {
    const deepTarget = join(tempDir, 'a', 'b', 'c', 'nested.ts')
    const content = 'export const x = 42;'
    const outcome = await writeFileAtomic(deepTarget, content)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'))
    }

    const written = await readFile(deepTarget, 'utf8')
    expect(written).toBe(content)
  })

  it('完全覆盖已有文件内容', async () => {
    const target = join(tempDir, 'overwrite.txt')
    await writeFileAtomic(target, 'old content')
    const outcome = await writeFileAtomic(target, 'new content')

    expect(outcome.ok).toBe(true)
    const written = await readFile(target, 'utf8')
    expect(written).toBe('new content')
  })
})
