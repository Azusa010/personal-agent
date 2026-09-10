import { describe, it, expect } from 'vitest'
import { extractPdf, type PdfExtractionResult } from './document-extract-pdf'
import { buildPdf, buildBlankPdf, buildCorruptPdf, buildEncryptedPdf } from './pdf-fixtures'

/** 断言成功并取出 pages，失败时把 code 打进报错便于定位 */
function pagesOf(result: PdfExtractionResult): { pageNumber: number; text: string }[] {
  if (!result.ok) throw new Error(`期望提取成功，实际失败: ${result.code} / ${result.reason}`)
  return result.pages
}

function codeOf(result: PdfExtractionResult): string {
  if (result.ok) throw new Error(`期望失败，实际成功提取 ${result.pages.length} 页`)
  return result.code
}

describe('extractPdf（TEST-006：文本、页码、空白、损坏、加密、扫描）', () => {
  it('单页：文本逐字准确', async () => {
    const pages = pagesOf(await extractPdf(buildPdf(['Hello PDF'])))

    expect(pages).toEqual([{ pageNumber: 1, text: 'Hello PDF' }])
  })

  it('多页：pageNumber 从 1 开始且与内容一一对应', async () => {
    const pages = pagesOf(await extractPdf(buildPdf(['alpha one', 'beta two', 'gamma three'])))

    // 页码映射是 REQ-007「页码引用可追溯」的地基，错位就等于虚假引用
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3])
    expect(pages.map((p) => p.text)).toEqual(['alpha one', 'beta two', 'gamma three'])
    expect(pages[1]).toEqual({ pageNumber: 2, text: 'beta two' })
  })

  it('Buffer 传入也能工作：钉住「tsc 放行但 pdfjs 拒绝」这个坑', async () => {
    // Buffer 是 Uint8Array 子类，这行 tsc 不报，
    // 若 extractPdf 内部漏了 toUint8 转换，运行时会炸成
    // "Please provide binary data as Uint8Array, rather than Buffer"
    const asBuffer: Buffer = Buffer.from(buildPdf(['from buffer']))

    const pages = pagesOf(await extractPdf(asBuffer))
    expect(pages[0]?.text).toBe('from buffer')
  })

  it('三类输入失败各返回自己的稳定 code', async () => {
    // 零字节必须在调 pdfjs 之前拦住，否则会被归进 PDF_CORRUPT
    expect(codeOf(await extractPdf(new Uint8Array(0)))).toBe('PDF_EMPTY')
    expect(codeOf(await extractPdf(buildCorruptPdf()))).toBe('PDF_CORRUPT')
    expect(codeOf(await extractPdf(buildEncryptedPdf()))).toBe('PDF_ENCRYPTED')
  })

  it('空白页与扫描型合并为 PDF_NO_TEXT；部分页有文本仍算成功', async () => {
    // 两页都是空白（空串 + 纯空格），pdfjs 层面 items.length === 0，无法区分扫描与空白
    expect(codeOf(await extractPdf(buildBlankPdf()))).toBe('PDF_NO_TEXT')

    // 封面扫描 + 正文有文本层：不能整体拒绝，否则误杀
    const mixed = pagesOf(await extractPdf(buildPdf(['', 'real content here'])))
    expect(mixed.map((p) => p.text)).toEqual(['', 'real content here'])
    expect(mixed.map((p) => p.pageNumber)).toEqual([1, 2])
  })
})
