import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import {
  getDocument,
  InvalidPDFException,
  PasswordException,
  PDFDocumentLoadingTask
} from 'pdfjs-dist/legacy/build/pdf.mjs'

function toUint8(buf: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export interface PageText {
  pageNumber: number
  text: string
}

export type PdfErrorCode = 'PDF_EMPTY' | 'PDF_CORRUPT' | 'PDF_ENCRYPTED' | 'PDF_NO_TEXT'

export type PdfExtractionResult =
  { ok: true; pages: PageText[] } | { ok: false; code: PdfErrorCode; reason: string }

const nodeRequire = createRequire(import.meta.url)

const STANDARD_FONT_DATA_URL = dirname(nodeRequire.resolve('pdfjs-dist/package.json'))
  .replace(/\\/g, '/')
  .concat('/standard_fonts/')

function fail(code: PdfErrorCode, reason: string): PdfExtractionResult {
  return { ok: false, code, reason }
}

export async function extractPdf(data: Uint8Array): Promise<PdfExtractionResult> {
  if (data.byteLength === 0) {
    return fail('PDF_EMPTY', 'PDF 文件为零字节')
  }

  let task: PDFDocumentLoadingTask | null = null
  try {
    task = getDocument({
      data: toUint8(data),
      standardFontDataUrl: STANDARD_FONT_DATA_URL
    })
    const doc = await task.promise

    const pages: PageText[] = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push({
        pageNumber,
        text: content.items.map((item) => ('str' in item ? item.str : '')).join('')
      })
    }
    if (pages.length > 0 && pages.every((p) => p.text.trim() === '')) {
      return fail('PDF_NO_TEXT', `PDF 有 ${pages.length} 页但没有任何文本层，可能是扫描件`)
    }
    return { ok: true, pages }
  } catch (e) {
    if (e instanceof PasswordException) {
      return fail('PDF_ENCRYPTED', `PDF 已加密: ${e.message}`)
    }
    if (e instanceof InvalidPDFException) {
      return fail('PDF_CORRUPT', `PDF 结构损坏: ${e.message}`)
    }
    throw e
  } finally {
    await task?.destroy()
  }
}
