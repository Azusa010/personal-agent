import { PdfEntry } from '@personal-agent/protocol'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { formatModifiedAt, toPosix } from './roots'

export interface ListDirectoryOptions {
  readonly pattern?: string
}

function matchesPattern(name: string, pattern?: string): boolean {
  if (!pattern || pattern.trim() === '') return true
  const lowerName = name.toLowerCase()
  const lowerPattern = pattern.trim().toLowerCase()
  if (lowerPattern.startsWith('*.')) {
    return lowerName.endsWith(lowerPattern.slice(1))
  }
  if (lowerPattern.includes('*')) {
    const escaped = lowerPattern.replace(/\./g, '\\.').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`, 'i').test(name)
  }
  return lowerName.includes(lowerPattern)
}

/**
 * 列出授权根目录下的条目（文件与子目录）。
 * 支持可选的通配符/后缀/关键词过滤 pattern（如 `*.pdf`），返回包含 type 的结构化条目。
 */
export async function listDirectory(
  base: string,
  options?: ListDirectoryOptions
): Promise<PdfEntry[]> {
  const names = await readdir(base)
  const scored: { mtimeMs: number; entry: PdfEntry }[] = []

  for (const name of names) {
    if (!matchesPattern(name, options?.pattern)) continue
    const full = join(base, name)
    try {
      const s = await stat(full)
      const entryType: 'file' | 'directory' = s.isDirectory() ? 'directory' : 'file'
      scored.push({
        mtimeMs: s.mtimeMs,
        entry: {
          name,
          absolutePath: toPosix(resolve(full)),
          modifiedAt: formatModifiedAt(s.mtimeMs),
          sizeBytes: s.size,
          type: entryType
        }
      })
    } catch {
      continue
    }
  }
  scored.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return scored.map((s) => s.entry)
}

/** 保留历史函数以完全兼容既有单元测试与依赖项。 */
export async function listPdfs(base: string): Promise<PdfEntry[]> {
  const all = await listDirectory(base, { pattern: '*.pdf' })
  return all.filter((e) => e.type === 'file')
}
