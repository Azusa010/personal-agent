import { readFile } from 'node:fs/promises'

import { DocumentExtractPdfParams, ERROR_CODE, ReadDocumentParams } from '@personal-agent/protocol'

import { extractPdf } from '../document-extract-pdf'
import { readDocument, type ReadDocumentOptions } from '../read-document'
import { resolveWithinRootReal } from '../path-guard'
import { resolveRoot } from '../roots'
import type { CapabilityPlugin } from '../plugin'
import { describeError, fail, invalid } from './helpers'

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

    const root = resolveRoot('downloads')
    const guarded = await resolveWithinRootReal(root, parsed.data.path)
    if (!guarded.ok) {
      return { ok: false, code: guarded.code, reason: guarded.reason }
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

export const documentExtractPdfPlugin: CapabilityPlugin = {
  name: 'document_extract_pdf',
  descriptor: {
    name: 'document_extract_pdf',
    kind: 'READ',
    description: '提取 PDF 每页文本与页码'
  },
  async bindArguments(args) {
    const parsed = DocumentExtractPdfParams.safeParse(args)
    if (!parsed.success) return invalid('document_extract_pdf', parsed.error.message)

    const root = resolveRoot('downloads')
    const guarded = await resolveWithinRootReal(root, parsed.data.path)
    if (!guarded.ok) {
      return { ok: false, code: guarded.code, reason: guarded.reason }
    }
    return {
      ok: true,
      bound: { args: { path: parsed.data.path }, paths: { path: guarded.path } }
    }
  },
  async execute(call) {
    const abs = call.bound.paths['path']
    let raw: Buffer
    try {
      raw = await readFile(abs)
    } catch (e) {
      return fail(ERROR_CODE.FILE_UNREADABLE, `读取失败 (${describeError(e)}): ${abs}`)
    }
    try {
      return await extractPdf(raw)
    } catch (e) {
      return fail(ERROR_CODE.PDF_EXTRACTION_FAILED, `PDF 解析失败 (${describeError(e)})`)
    }
  }
}
