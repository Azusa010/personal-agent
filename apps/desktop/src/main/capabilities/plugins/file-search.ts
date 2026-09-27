import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { ERROR_CODE, FileSearchParams, type FileSearchMatch } from '@personal-agent/protocol'

import { resolveWithinRootReal } from '../path-guard'
import { resolveRoot, toPosix } from '../roots'
import type { CapabilityPlugin } from '../plugin'
import { fail, invalid } from './helpers'

function matchName(name: string, pattern: string): boolean {
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

export const fileSearchPlugin: CapabilityPlugin = {
  name: 'file_search',
  descriptor: {
    name: 'file_search',
    kind: 'READ',
    description: '跨平台文件与内容检索，支持文件名通配符及纯文本/正则行检索'
  },
  async bindArguments(args) {
    const parsed = FileSearchParams.safeParse(args)
    if (!parsed.success) return invalid('file_search', parsed.error.message)

    const root = resolveRoot('downloads')
    let searchDir = root

    if (parsed.data.relativeRoot) {
      const guarded = await resolveWithinRootReal(root, parsed.data.relativeRoot)
      if (!guarded.ok) {
        return { ok: false, code: guarded.code, reason: guarded.reason }
      }
      searchDir = guarded.path
    }

    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: { searchDir }
      }
    }
  },
  async execute(call) {
    const root = resolveRoot('downloads')
    const searchDir = call.bound.paths['searchDir'] ?? root
    const pattern = String(call.bound.args['pattern'])
    const searchMode = String(call.bound.args['searchMode'] ?? 'filename')
    const maxMatches =
      typeof call.bound.args['maxMatches'] === 'number' ? call.bound.args['maxMatches'] : 50

    let regex: RegExp | null = null
    if (searchMode === 'content_regex') {
      try {
        regex = new RegExp(pattern, 'i')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return fail(ERROR_CODE.INVALID_ARGUMENT, `无效的正则表达式 (${pattern}): ${msg}`)
      }
    }

    const matches: FileSearchMatch[] = []
    let totalMatches = 0
    let truncated = false

    async function walk(currentDir: string): Promise<void> {
      if (truncated) return
      let entries: string[]
      try {
        entries = await readdir(currentDir)
      } catch {
        return
      }

      for (const entry of entries) {
        if (truncated) return
        if (entry === '.git' || entry === 'node_modules' || entry === '.scratch') continue

        const fullPath = join(currentDir, entry)
        let s
        try {
          s = await stat(fullPath)
        } catch {
          continue
        }

        if (s.isDirectory()) {
          await walk(fullPath)
        } else if (s.isFile()) {
          const relPath = toPosix(relative(root, fullPath))

          if (searchMode === 'filename') {
            if (matchName(entry, pattern)) {
              totalMatches++
              if (matches.length < maxMatches) {
                matches.push({ path: relPath })
              } else {
                truncated = true
                return
              }
            }
          } else {
            // content search
            let content: string
            try {
              content = await readFile(fullPath, 'utf8')
            } catch {
              continue
            }

            const lines = content.split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!
              let matched = false
              if (searchMode === 'content_plain') {
                matched = line.toLowerCase().includes(pattern.toLowerCase())
              } else if (regex) {
                matched = regex.test(line)
              }

              if (matched) {
                totalMatches++
                if (matches.length < maxMatches) {
                  matches.push({
                    path: relPath,
                    lineNumber: i + 1,
                    lineContent: line.trim()
                  })
                } else {
                  truncated = true
                  return
                }
              }
            }
          }
        }
      }
    }

    await walk(searchDir)

    return {
      ok: true,
      totalMatches,
      truncated,
      matches
    }
  }
}
