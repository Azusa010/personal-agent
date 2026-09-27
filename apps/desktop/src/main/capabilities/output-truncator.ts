import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { toPosix } from './roots'

export interface TruncateOptions {
  readonly maxLines?: number
  readonly maxBytes?: number
  readonly headLines?: number
  readonly tailLines?: number
  readonly scratchDir: string
  readonly prefix?: string
}

export interface TruncatedOutputResult {
  readonly text: string
  readonly truncated: boolean
  readonly logRelativePath?: string
  readonly logAbsolutePath?: string
}

/**
 * Head/Tail 长输出治理器（第 4 章：执行工具安全与截断持久化）。
 * 当输出行数超出 maxLines (默认 200) 或字节数超出 maxBytes (默认 10KB) 时：
 * 提取前 headLines (默认 50) + 后 tailLines (默认 50) 行，将完整内容持久化到 scratchDir，
 * 并生成带引导说明的截断提示（引导模型调用 read_document 查看完整日志）。
 */
export async function truncateOutput(
  rawText: string,
  options: TruncateOptions
): Promise<TruncatedOutputResult> {
  const maxLines = options.maxLines ?? 200
  const maxBytes = options.maxBytes ?? 10 * 1024
  const headLines = options.headLines ?? 50
  const tailLines = options.tailLines ?? 50

  const lines = rawText.split(/\r?\n/)
  const isTooManyLines = lines.length > maxLines
  const isTooManyBytes = Buffer.byteLength(rawText, 'utf8') > maxBytes

  if (!isTooManyLines && !isTooManyBytes) {
    return {
      text: rawText,
      truncated: false
    }
  }

  await mkdir(options.scratchDir, { recursive: true })
  const filename = `${options.prefix ?? 'term_output'}_${Date.now()}_${randomUUID().slice(0, 8)}.log`
  const logAbs = toPosix(join(options.scratchDir, filename))
  await writeFile(logAbs, rawText, 'utf8')

  const head = lines.slice(0, headLines).join('\n')
  const tail = lines.slice(-tailLines).join('\n')
  const omittedCount = Math.max(1, lines.length - headLines - tailLines)

  const notice = `\n... [系统截断：省略 ${omittedCount} 行。完整日志已保存至 ${filename}，可使用 read_document 查阅] ...\n`
  const truncatedText = `${head}${notice}${tail}`

  return {
    text: truncatedText,
    truncated: true,
    logRelativePath: filename,
    logAbsolutePath: logAbs
  }
}
