import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ERROR_CODE,
  SkillReadParams,
  SkillSearchParams,
  type SkillMetadata
} from '@personal-agent/protocol'

import { resolveRoot } from '../roots'
import type { CapabilityDescriptor } from '../registry'
import type { CapabilityPlugin } from '../plugin'
import { fail, invalid } from './helpers'

export interface SkillDetail extends SkillMetadata {
  readonly content: string
  readonly path: string
}

const BUILTIN_SKILLS: readonly SkillDetail[] = [
  {
    name: 'data-cleaner',
    description: '规范化表格与 CSV 数据，清洗缺失值与异常格式',
    tags: ['data', 'csv', 'clean'],
    content:
      '# Data Cleaner Skill\n\n使用此技能清洗表格与 CSV 数据。在进行聚合分析前，统一时间戳为 ISO-8601，填充空缺数值。',
    path: 'builtin://data-cleaner'
  },
  {
    name: 'pdf-table-extractor',
    description: '精确提取财务与年报 PDF 中的多行多列表格数据',
    tags: ['pdf', 'table', 'finance'],
    content:
      '# PDF Table Extractor\n\n针对复杂 PDF 表格的专用提取技能。先利用 read_document 读取目标页，再提取结构化表格数据。',
    path: 'builtin://pdf-table-extractor'
  },
  {
    name: 'code-refactoring',
    description: '依据清晰架构原则重构代码模块，解耦依赖与消除循环引用',
    tags: ['code', 'refactor', 'architecture'],
    content:
      '# Code Refactoring Skill\n\n代码重构指导：提取自描述插件 (CapabilityPlugin)、去除散落 switch-case、收敛跨模块通信契约。',
    path: 'builtin://code-refactoring'
  }
]

const IGNORED_FILES = new Set(['readme.md', 'license.md', 'changelog.md'])

function isIgnoredFile(filename: string): boolean {
  if (filename.startsWith('.')) return true
  return IGNORED_FILES.has(filename.toLowerCase())
}

function stripQuotes(str: string): string {
  const trimmed = str.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function parseSkillContent(
  rawContent: string,
  fallbackName: string,
  skillPath: string
): SkillDetail {
  // 去除 UTF-8 BOM
  const sanitized = rawContent.replace(/^\uFEFF/, '')
  let name = fallbackName
  let description = ''
  const tags: string[] = []

  // 支持前导空行的 frontmatter 匹配
  const frontmatterMatch = sanitized.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1]
    const body = frontmatterMatch[2].trim()

    let currentSection: 'tags' | null = null

    for (const rawLine of yaml.split(/\r?\n/)) {
      const trimmed = rawLine.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      if (trimmed.startsWith('name:')) {
        currentSection = null
        const val = stripQuotes(trimmed.slice(5))
        if (val) name = val
      } else if (trimmed.startsWith('description:')) {
        currentSection = null
        description = stripQuotes(trimmed.slice(12))
      } else if (trimmed.startsWith('tags:')) {
        const rest = trimmed.slice(5).trim()
        if (rest.startsWith('[') && rest.endsWith(']')) {
          currentSection = null
          const parsedTags = rest
            .slice(1, -1)
            .split(',')
            .map((t) => stripQuotes(t))
            .filter(Boolean)
          tags.push(...parsedTags)
        } else {
          currentSection = 'tags'
        }
      } else if (currentSection === 'tags' && trimmed.startsWith('-')) {
        const tagVal = stripQuotes(trimmed.slice(1))
        if (tagVal) {
          tags.push(tagVal)
        }
      } else {
        currentSection = null
      }
    }

    return {
      name,
      description: description || `Skill ${name}`,
      tags,
      content: body || sanitized,
      path: skillPath
    }
  }

  // 无 frontmatter 时：保持 fallbackName 作为技能 slug 标识符，从正文提取标题与第一段作为摘要
  const titleMatch = sanitized.match(/^#\s+(.+)$/m)
  const lines = sanitized
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  if (titleMatch && lines.length > 0) {
    description = `${titleMatch[1].trim()}: ${lines[0]}`
  } else if (lines.length > 0) {
    description = lines[0]
  } else if (titleMatch) {
    description = titleMatch[1].trim()
  } else {
    description = `Skill ${fallbackName}`
  }

  return {
    name: fallbackName,
    description,
    tags,
    content: sanitized,
    path: skillPath
  }
}

/**
 * 扫描指定根目录下的技能目录，解析并写入 skillsMap。
 * @param rootDir 根目录绝对路径（如 downloads 或 workspace 根）
 * @param subDir 技能子目录相对路径（如 '.skills' 或 '.agent/skills'）
 * @param skillsMap 收集目标 Map，后写入的技能将覆盖同名先写入的技能
 */
export async function scanSkillsDir(
  rootDir: string,
  subDir: string,
  skillsMap: Map<string, SkillDetail>
): Promise<void> {
  const skillsDir = join(rootDir, subDir)
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue

        const subDirPath = join(skillsDir, entry.name)
        try {
          const subEntries = await readdir(subDirPath)
          const matchedFileName =
            subEntries.find((f) => f === 'SKILL.md') ??
            subEntries.find((f) => f.toLowerCase() === 'skill.md')

          if (!matchedFileName) continue

          const skillFile = join(subDirPath, matchedFileName)
          const content = await readFile(skillFile, 'utf-8')
          const skill = parseSkillContent(
            content,
            entry.name,
            `${subDir}/${entry.name}/${matchedFileName}`
          )
          skillsMap.set(skill.name.toLowerCase(), skill)
        } catch {
          // ignore directory read error
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (isIgnoredFile(entry.name)) continue

        const skillFile = join(skillsDir, entry.name)
        try {
          const content = await readFile(skillFile, 'utf-8')
          const baseName = entry.name.slice(0, -3)
          const skill = parseSkillContent(content, baseName, `${subDir}/${entry.name}`)
          skillsMap.set(skill.name.toLowerCase(), skill)
        } catch {
          // ignore read error
        }
      }
    }
  } catch {
    // 目录不存在则静默忽略
  }
}

// ---------------- 缓存与指纹校验机制 ----------------

interface SkillsCache {
  skills: SkillDetail[]
  timestamp: number
  fingerprint: string
}

let cache: SkillsCache | null = null
const CACHE_TTL_MS = 10_000

/**
 * 显式清空技能缓存（用于单测隔离或文件系统外部变动时强制刷新）
 */
export function clearSkillsCache(): void {
  cache = null
}

async function getDirFingerprint(dirPath: string): Promise<string> {
  try {
    const dirStat = await stat(dirPath)
    let fp = `${dirStat.mtimeMs}:`
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        fp += `${entry.name}:`
        try {
          const subEntries = await readdir(join(dirPath, entry.name))
          const matched =
            subEntries.find((f) => f === 'SKILL.md') ??
            subEntries.find((f) => f.toLowerCase() === 'skill.md')
          if (matched) {
            const s = await stat(join(dirPath, entry.name, matched))
            fp += `${matched}=${s.mtimeMs};`
          } else {
            fp += 'none;'
          }
        } catch {
          fp += 'none;'
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (isIgnoredFile(entry.name)) continue
        try {
          const s = await stat(join(dirPath, entry.name))
          fp += `${entry.name}=${s.mtimeMs};`
        } catch {
          // ignore
        }
      }
    }
    return fp
  } catch {
    return 'none'
  }
}

async function computeAllFingerprints(): Promise<string> {
  const parts: string[] = []

  try {
    const downloadsRoot = resolveRoot('downloads')
    parts.push(await getDirFingerprint(join(downloadsRoot, '.skills')))
  } catch {
    parts.push('none')
  }

  try {
    const workspaceRoot = resolveRoot('workspace')
    parts.push(await getDirFingerprint(join(workspaceRoot, '.skills')))
    parts.push(await getDirFingerprint(join(workspaceRoot, '.agent', 'skills')))
  } catch {
    parts.push('none', 'none')
  }

  return parts.join('|')
}

/**
 * 加载所有可用技能，执行多源发现与优先级覆盖合并。
 * 覆盖优先级规则：workspace/.agent/skills > workspace/.skills > downloads/.skills > BUILTIN_SKILLS。
 */
export async function loadAllSkills(): Promise<SkillDetail[]> {
  const now = Date.now()
  const currentFingerprint = await computeAllFingerprints()

  if (cache && now - cache.timestamp < CACHE_TTL_MS && cache.fingerprint === currentFingerprint) {
    return cache.skills
  }

  const skillsMap = new Map<string, SkillDetail>()
  for (const skill of BUILTIN_SKILLS) {
    skillsMap.set(skill.name.toLowerCase(), skill)
  }

  try {
    const downloadsRoot = resolveRoot('downloads')
    await scanSkillsDir(downloadsRoot, '.skills', skillsMap)
  } catch {
    // 静默忽略 downloads 未配置或路径异常
  }

  try {
    const workspaceRoot = resolveRoot('workspace')
    // 先扫 workspace/.skills，再扫 workspace/.agent/skills（优先级更高）
    await scanSkillsDir(workspaceRoot, '.skills', skillsMap)
    await scanSkillsDir(workspaceRoot, '.agent/skills', skillsMap)
  } catch {
    // 静默忽略 workspace 未配置或路径异常
  }

  const result = Array.from(skillsMap.values())
  cache = {
    skills: result,
    timestamp: now,
    fingerprint: currentFingerprint
  }

  return result
}

export const skillSearchPlugin: CapabilityPlugin = {
  name: 'skill_search',
  descriptor: {
    name: 'skill_search',
    kind: 'READ',
    description: '按关键词或标签检索 Agent Skills 目录，仅返回轻量元数据以保护上下文与 KV Cache'
  } as CapabilityDescriptor,
  async bindArguments(args) {
    const parsed = SkillSearchParams.safeParse(args)
    if (!parsed.success) return invalid('skill_search', parsed.error.message)

    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: {}
      }
    }
  },
  async execute(call) {
    const query =
      typeof call.bound.args['query'] === 'string' ? call.bound.args['query'].toLowerCase() : null
    const tag =
      typeof call.bound.args['tag'] === 'string' ? call.bound.args['tag'].toLowerCase() : null
    const maxResults =
      typeof call.bound.args['maxResults'] === 'number' ? call.bound.args['maxResults'] : 20

    const allSkills = await loadAllSkills()
    let filtered = allSkills

    if (query && query !== '*' && query !== 'all') {
      filtered = filtered.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query) ||
          s.tags.some((t) => t.toLowerCase().includes(query))
      )
    }

    if (tag) {
      filtered = filtered.filter((s) => s.tags.some((t) => t.toLowerCase() === tag))
    }

    const limited = filtered.slice(0, maxResults)
    return {
      ok: true,
      total: limited.length,
      skills: limited.map((s) => ({
        name: s.name,
        description: s.description,
        tags: s.tags,
        path: s.path
      }))
    }
  }
}

export const skillReadPlugin: CapabilityPlugin = {
  name: 'skill_read',
  descriptor: {
    name: 'skill_read',
    kind: 'READ',
    description: '按需加载指定 Skill 的完整指令正文 (SKILL.md)，实现渐进式披露'
  } as CapabilityDescriptor,
  async bindArguments(args) {
    const parsed = SkillReadParams.safeParse(args)
    if (!parsed.success) return invalid('skill_read', parsed.error.message)

    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: {}
      }
    }
  },
  async execute(call) {
    const name = String(call.bound.args['name'])
    const allSkills = await loadAllSkills()
    const found = allSkills.find(
      (s) => s.name === name || s.name.toLowerCase() === name.toLowerCase()
    )

    if (!found) {
      return fail(ERROR_CODE.INVALID_ARGUMENT, `Skill "${name}" not found.`)
    }

    return {
      ok: true,
      name: found.name,
      description: found.description,
      tags: found.tags,
      content: found.content,
      path: found.path
    }
  }
}
