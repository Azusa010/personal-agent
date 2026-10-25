import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  getDocument,
  InvalidPDFException,
  PasswordException,
  PDFDocumentLoadingTask
} from 'pdfjs-dist/legacy/build/pdf.mjs'

import {
  ERROR_CODE,
  ReadDocumentParams,
  type DocumentFileType,
  type DocumentPage,
  type ReadDocumentOutcome
} from '@personal-agent/protocol'

import { resolvePathReal } from '../path-guard'
import { resolveRoot } from '../roots'
import type { CapabilityPlugin } from '../plugin'
import { invalid } from './helpers'

// ==========================================
// 1. PDF 提取核心执行体与助手函数
// ==========================================

function toUint8(buf: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export type PdfErrorCode = 'PDF_EMPTY' | 'PDF_CORRUPT' | 'PDF_ENCRYPTED' | 'PDF_NO_TEXT'

export type PdfPage = { pageNumber: number; text: string }

export type PdfExtractionResult =
  | { ok: true; pages: PdfPage[] }
  | { ok: false; code: PdfErrorCode; reason: string }

const nodeRequire = createRequire(import.meta.url)

const STANDARD_FONT_DATA_URL = dirname(nodeRequire.resolve('pdfjs-dist/package.json'))
  .replace(/\\/g, '/')
  .concat('/standard_fonts/')

function failPdf(code: PdfErrorCode, reason: string): PdfExtractionResult {
  return { ok: false, code, reason }
}

export async function extractPdf(data: Uint8Array): Promise<PdfExtractionResult> {
  if (data.byteLength === 0) {
    return failPdf('PDF_EMPTY', 'PDF 文件为零字节')
  }

  let task: PDFDocumentLoadingTask | null = null
  try {
    task = getDocument({
      data: toUint8(data),
      standardFontDataUrl: STANDARD_FONT_DATA_URL
    })
    const doc = await task.promise

    const pages: PdfPage[] = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push({
        pageNumber,
        text: content.items.map((item) => ('str' in item ? item.str : '')).join('')
      })
    }
    if (pages.length > 0 && pages.every((p) => p.text.trim() === '')) {
      return failPdf('PDF_NO_TEXT', `PDF 有 ${pages.length} 页但没有任何文本层，可能是扫描件`)
    }
    return { ok: true, pages }
  } catch (e) {
    if (e instanceof PasswordException) {
      return failPdf('PDF_ENCRYPTED', `PDF 已加密: ${e.message}`)
    }
    if (e instanceof InvalidPDFException) {
      return failPdf('PDF_CORRUPT', `PDF 损坏或格式错误: ${e.message}`)
    }
    return failPdf('PDF_CORRUPT', `PDF 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    if (task) {
      try {
        await task.destroy()
      } catch {
        // 忽略销毁异常
      }
    }
  }
}

// ==========================================
// 2. 统一多格式文档读取执行体 (readDocument)
// ==========================================

export interface ReadDocumentOptions {
  readonly fileType?: DocumentFileType
  readonly pageStart?: number
  readonly pageEnd?: number
  readonly maxCharsPerPage?: number
}

function resolveFileType(path: string, explicitType?: DocumentFileType): DocumentFileType {
  if (explicitType && explicitType !== 'auto') {
    return explicitType
  }
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.pptx') return 'pptx'
  if (ext === '.xlsx') return 'xlsx'
  if (['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.log', '.csv'].includes(ext)) {
    return 'text'
  }
  return 'auto'
}

/**
 * 现代化统一文档阅读器 (read_document)。
 * 支持多格式扩展、按需分页读取 (pageStart, pageEnd)、单页字符超限截断与翻页指引 (hasMore, nextPage)。
 */
export async function readDocument(
  absPath: string,
  options: ReadDocumentOptions = {}
): Promise<ReadDocumentOutcome> {
  const fileType = resolveFileType(absPath, options.fileType)
  const pageStart = Math.max(1, options.pageStart ?? 1)
  const pageEnd = options.pageEnd
  const maxCharsPerPage = options.maxCharsPerPage ?? 4000

  let rawBuffer: Buffer
  try {
    rawBuffer = await readFile(absPath)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      code: ERROR_CODE.FILE_UNREADABLE,
      reason: `文件读取失败 (${msg}): ${absPath}`
    }
  }

  let extractedPages: { pageNumber: number; text: string }[] = []

  if (fileType === 'pdf') {
    let pdfOutcome:
      | { ok: true; pages: { pageNumber: number; text: string }[] }
      | { ok: false; code: string; reason: string }
    try {
      pdfOutcome = await extractPdf(rawBuffer)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        code: ERROR_CODE.PDF_EXTRACTION_FAILED,
        reason: `PDF 解析失败 (${msg}): ${absPath}`
      }
    }
    if (!pdfOutcome.ok) {
      return {
        ok: false,
        code: pdfOutcome.code,
        reason: pdfOutcome.reason
      }
    }
    extractedPages = pdfOutcome.pages
  } else if (fileType === 'text') {
    const textContent = rawBuffer.toString('utf8')
    if (textContent.includes('\f')) {
      const rawPages = textContent.split('\f')
      extractedPages = rawPages.map((text, idx) => ({ pageNumber: idx + 1, text: text.trim() }))
    } else {
      const lines = textContent.split(/\r?\n/)
      const pageSize = 50
      const pagesCount = Math.max(1, Math.ceil(lines.length / pageSize))
      for (let i = 0; i < pagesCount; i++) {
        const pageText = lines.slice(i * pageSize, (i + 1) * pageSize).join('\n')
        extractedPages.push({ pageNumber: i + 1, text: pageText })
      }
    }
  } else {
    return {
      ok: false,
      code: ERROR_CODE.INVALID_ARGUMENT,
      reason: `暂不支持的文件类型或非纯文本格式: ${fileType} (${absPath})`
    }
  }

  const totalPages = extractedPages.length
  const startIndex = pageStart - 1
  const endIndex = pageEnd !== undefined ? Math.min(pageEnd, totalPages) : totalPages

  const sliced = extractedPages.slice(startIndex, endIndex)
  const resultPages: DocumentPage[] = sliced.map((page) => {
    if (page.text.length > maxCharsPerPage) {
      return {
        pageNumber: page.pageNumber,
        text: `${page.text.slice(0, maxCharsPerPage)}\n... [系统截断：本页内容超出 ${maxCharsPerPage} 字符上限] ...`,
        truncated: true
      }
    }
    return {
      pageNumber: page.pageNumber,
      text: page.text,
      truncated: false
    }
  })

  const hasMore = endIndex < totalPages
  const nextPage = hasMore ? endIndex + 1 : null

  return {
    ok: true,
    path: absPath,
    totalPages,
    returnedPages: resultPages.length,
    hasMore,
    nextPage,
    pages: resultPages
  }
}

// ==========================================
// 3. 自描述插件声明 (CapabilityPlugin)
// ==========================================

export const readDocumentPlugin: CapabilityPlugin = {
  name: 'read_document',
  descriptor: {
    name: 'read_document',
    kind: 'READ',
    description: '多格式统一文档读取器，提取逐页文本并支持分页与字符限制 (PDF/Word/Markdown/Text)'
  },
  async bindArguments(args) {
    const parsed = ReadDocumentParams.safeParse(args)
    if (!parsed.success) return invalid('read_document', parsed.error.message)

    // 读不设根界：相对路径以工作区为基准，绝对路径全盘可读（卫生校验照走）
    const base = resolveRoot('workspace')
    const absCandidate = isAbsolute(parsed.data.path)
      ? parsed.data.path
      : resolve(base, parsed.data.path)
    const guarded = await resolvePathReal(absCandidate)
    if (!guarded.ok) {
      return {
        ok: false,
        code: guarded.code,
        reason: `${guarded.reason}（read_document 的 path 参数）`
      }
    }
    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: { path: guarded.path }
      }
    }
  },
  async execute(call) {
    const abs = call.bound.paths['path']
    const options: ReadDocumentOptions = {
      fileType: call.bound.args['fileType'] as ReadDocumentOptions['fileType'],
      pageStart:
        typeof call.bound.args['pageStart'] === 'number' ? call.bound.args['pageStart'] : undefined,
      pageEnd:
        typeof call.bound.args['pageEnd'] === 'number' ? call.bound.args['pageEnd'] : undefined,
      maxCharsPerPage:
        typeof call.bound.args['maxCharsPerPage'] === 'number'
          ? call.bound.args['maxCharsPerPage']
          : undefined
    }
    return readDocument(abs, options)
  }
}
