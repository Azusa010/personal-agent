import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ERROR_CODE } from '@personal-agent/protocol'
import { readDocument } from '../../../src/main/capabilities/read-document'
import { buildCorruptPdf, buildPdf } from '../../../src/main/capabilities/pdf-fixtures'

describe('readDocument (Modernized Unified Document Reader)', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'read-doc-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('读取 PDF 多页并自动分页与统计', async () => {
    const pdfPath = join(tempDir, 'sample.pdf')
    await writeFile(pdfPath, buildPdf(['Page 1 text', 'Page 2 text', 'Page 3 text']))

    const result = await readDocument(pdfPath)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.totalPages).toBe(3)
    expect(result.returnedPages).toBe(3)
    expect(result.hasMore).toBe(false)
    expect(result.nextPage).toBeNull()
    expect(result.pages).toHaveLength(3)
    expect(result.pages[0]).toEqual({ pageNumber: 1, text: 'Page 1 text', truncated: false })
    expect(result.pages[1]).toEqual({ pageNumber: 2, text: 'Page 2 text', truncated: false })
    expect(result.pages[2]).toEqual({ pageNumber: 3, text: 'Page 3 text', truncated: false })
  })

  it('支持按需分页 (pageStart, pageEnd)', async () => {
    const pdfPath = join(tempDir, 'sample.pdf')
    await writeFile(
      pdfPath,
      buildPdf(['First page', 'Second page', 'Third page', 'Fourth page', 'Fifth page'])
    )

    const result = await readDocument(pdfPath, { pageStart: 2, pageEnd: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.totalPages).toBe(5)
    expect(result.returnedPages).toBe(2)
    expect(result.hasMore).toBe(true)
    expect(result.nextPage).toBe(4)
    expect(result.pages.map((p) => p.pageNumber)).toEqual([2, 3])
    expect(result.pages[0]?.text).toBe('Second page')
    expect(result.pages[1]?.text).toBe('Third page')
  })

  it('支持单页字符超限截断 (maxCharsPerPage) 并显式标记 truncated', async () => {
    const pdfPath = join(tempDir, 'sample.pdf')
    const longText = 'A'.repeat(500)
    await writeFile(pdfPath, buildPdf([longText]))

    const result = await readDocument(pdfPath, { maxCharsPerPage: 20 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.pages[0]?.truncated).toBe(true)
    expect(result.pages[0]?.text).toContain('... [系统截断：本页内容超出 20 字符上限] ...')
    expect(result.pages[0]?.text.startsWith('A'.repeat(20))).toBe(true)
  })

  it('支持读取文本与 Markdown 文件', async () => {
    const mdPath = join(tempDir, 'notes.md')
    await writeFile(mdPath, '# Header\nLine 1\nLine 2\n\f# Page 2\nMore content')

    const result = await readDocument(mdPath)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.totalPages).toBe(2)
    expect(result.pages[0]?.text).toBe('# Header\nLine 1\nLine 2')
    expect(result.pages[1]?.text).toBe('# Page 2\nMore content')
  })

  it('文件不存在时返回稳定错误码 FILE_UNREADABLE', async () => {
    const notFound = join(tempDir, 'not_found.pdf')
    const result = await readDocument(notFound)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.code).toBe(ERROR_CODE.FILE_UNREADABLE)
  })

  it('损坏 PDF 返回稳定错误码 PDF_CORRUPT', async () => {
    const corruptPath = join(tempDir, 'corrupt.pdf')
    await writeFile(corruptPath, buildCorruptPdf())

    const result = await readDocument(corruptPath)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.code).toBe('PDF_CORRUPT')
  })

  it('不支持的文件类型返回 INVALID_ARGUMENT', async () => {
    const unknownPath = join(tempDir, 'sample.xyz')
    await writeFile(unknownPath, 'dummy binary or text')

    const result = await readDocument(unknownPath)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })
})
