import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ERROR_CODE } from '@personal-agent/protocol'

import { formatFileLines, readFileWithLineNumbers } from './file-read'

describe('file-read: formatFileLines', () => {
  it('处理空字符串返回空内容与 0 行', () => {
    const res = formatFileLines('')
    expect(res.totalLines).toBe(0)
    expect(res.content).toBe('')
  })

  it('多行文本默认添加行号前缀并保留总行数', () => {
    const raw = 'line A\nline B\nline C'
    const res = formatFileLines(raw)
    expect(res.totalLines).toBe(3)
    expect(res.startLine).toBe(1)
    expect(res.endLine).toBe(3)
    expect(res.content).toBe('1: line A\n2: line B\n3: line C')
  })

  it('指定 [startLine, endLine] 截取指定行区间', () => {
    const raw = 'one\ntwo\nthree\nfour\nfive'
    const res = formatFileLines(raw, 2, 4)
    expect(res.totalLines).toBe(5)
    expect(res.startLine).toBe(2)
    expect(res.endLine).toBe(4)
    expect(res.content).toBe('2: two\n3: three\n4: four')
  })

  it('endLine 超出文件实际总行数时截断至总行数', () => {
    const raw = 'alpha\nbeta'
    const res = formatFileLines(raw, 1, 999)
    expect(res.totalLines).toBe(2)
    expect(res.startLine).toBe(1)
    expect(res.endLine).toBe(2)
    expect(res.content).toBe('1: alpha\n2: beta')
  })

  it('startLine > endLine 时返回空内容', () => {
    const raw = 'alpha\nbeta\ngamma'
    const res = formatFileLines(raw, 3, 2)
    expect(res.content).toBe('')
    expect(res.totalLines).toBe(3)
  })
})

describe('file-read: readFileWithLineNumbers', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-test-file-read-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('成功读取真实文件并返回带行号内容', () => {
    // 异步由外层包装
    return (async () => {
      const filePath = join(tempDir, 'demo.txt')
      await writeFile(filePath, 'foo\nbar\nbaz', 'utf8')

      const outcome = await readFileWithLineNumbers(filePath, { startLine: 1, endLine: 2 })
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.path).toBe(filePath)
        expect(outcome.totalLines).toBe(3)
        expect(outcome.content).toBe('1: foo\n2: bar')
      }
    })()
  })

  it('文件不存在时返回稳定错误码 FILE_UNREADABLE', async () => {
    const nonExistent = join(tempDir, 'not-found.txt')
    const outcome = await readFileWithLineNumbers(nonExistent)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(ERROR_CODE.FILE_UNREADABLE)
    }
  })

  it('目标路径是目录时返回稳定错误码 FILE_UNREADABLE', async () => {
    const subDir = join(tempDir, 'sub')
    await mkdir(subDir)
    const outcome = await readFileWithLineNumbers(subDir)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(ERROR_CODE.FILE_UNREADABLE)
      expect(outcome.reason).toContain('目录')
    }
  })
})
