import {
  ERROR_CODE,
  FileReadOutcome,
  FileReadParams,
  FileReadResult
} from '@personal-agent/protocol'

import type { CapabilityPlugin } from '../plugin'
import { readFile, stat } from 'node:fs/promises'
import { defineBinder } from '../binder'

export interface ReadFileOptions {
  readonly startLine?: number
  readonly endLine?: number
}

export interface FormattedLines {
  readonly content: string
  readonly totalLines: number
  readonly startLine: number
  readonly endLine: number
}

export function formatFileLines(
  rawText: string,
  startLine?: number,
  endLine?: number
): FormattedLines {
  if (rawText === '') {
    return {
      content: '',
      totalLines: 0,
      startLine: 1,
      endLine: 0
    }
  }
  const lines = rawText.split(/\r?\n/)
  const totalLines = lines.length
  const actualStart = Math.max(1, startLine ?? 1)
  const actualEnd = Math.min(totalLines, endLine ?? totalLines)

  if (actualStart > actualEnd) {
    return {
      content: '',
      totalLines,
      startLine: actualStart,
      endLine: actualEnd
    }
  }

  const slicedLines = lines.slice(actualStart - 1, actualEnd)
  const formattedLines = slicedLines.map((line, index) => `${actualStart + index}: ${line}`)
  const content = formattedLines.join('\n')

  return {
    content,
    totalLines,
    startLine: actualStart,
    endLine: actualEnd
  }
}

export async function readFileWithLineNumbers(
  absPath: string,
  options: ReadFileOptions = {}
): Promise<FileReadOutcome> {
  let fileStats
  try {
    fileStats = await stat(absPath)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      code: ERROR_CODE.FILE_UNREADABLE,
      reason: `文件不存在或无法访问 (${msg}): ${absPath}`
    }
  }

  if (fileStats.isDirectory()) {
    return {
      ok: false,
      code: ERROR_CODE.FILE_UNREADABLE,
      reason: `目标路径是目录而非文件: ${absPath}`
    }
  }

  let rawText: string
  try {
    rawText = await readFile(absPath, 'utf8')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      code: ERROR_CODE.FILE_UNREADABLE,
      reason: `文件读取失败 (${msg}): ${absPath}`
    }
  }

  const formatted = formatFileLines(rawText, options.startLine, options.endLine)

  const result: FileReadResult = {
    ok: true,
    path: absPath,
    content: formatted.content,
    totalLines: formatted.totalLines,
    startLine: formatted.startLine,
    endLine: formatted.endLine
  }
  return result
}

export const fileReadPlugin: CapabilityPlugin = {
  name: 'file_read',
  descriptor: {
    name: 'file_read',
    kind: 'READ',
    description: '读取指定文件内容，支持按起始行号与结束行号分页读取，每行自带行号前缀'
  },
  bindArguments: defineBinder('file_read', FileReadParams, [{ field: 'path', root: 'workspace' }]),
  async execute(call) {
    const absPath = call.bound.paths['path']
    const startLine =
      typeof call.bound.args['startLine'] === 'number' ? call.bound.args['startLine'] : undefined
    const endLine =
      typeof call.bound.args['endLine'] === 'number' ? call.bound.args['endLine'] : undefined

    return readFileWithLineNumbers(absPath, { startLine, endLine })
  }
}
