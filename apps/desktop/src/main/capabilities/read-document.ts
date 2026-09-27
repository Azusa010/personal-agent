import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import {
  ERROR_CODE,
  type DocumentFileType,
  type DocumentPage,
  type ReadDocumentOutcome
} from '@personal-agent/protocol'

import { extractPdf } from './document-extract-pdf'

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
    // 如果有换页符 \f 则按页切分，否则按行聚合分页（每页约 50 行或 3000 字）
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
