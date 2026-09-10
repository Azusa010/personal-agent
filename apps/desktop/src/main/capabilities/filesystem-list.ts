import { PdfEntry } from '@personal-agent/protocol'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { formatModifiedAt, toPosix } from './roots'

export async function listPdfs(base: string): Promise<PdfEntry[]> {
  const names = await readdir(base)
  const scored: { mtimeMs: number; entry: PdfEntry }[] = []

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.pdf')) continue
    const full = join(base, name)
    try {
      const s = await stat(full)
      if (!s.isFile()) continue
      scored.push({
        mtimeMs: s.mtimeMs,
        entry: {
          name,
          absolutePath: toPosix(resolve(full)),
          modifiedAt: formatModifiedAt(s.mtimeMs),
          sizeBytes: s.size
        }
      })
    } catch {
      continue
    }
  }
  scored.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return scored.map((s) => s.entry)
}
