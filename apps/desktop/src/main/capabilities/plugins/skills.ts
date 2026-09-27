import { readdir, readFile } from 'node:fs/promises'
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

function parseSkillContent(
  rawContent: string,
  fallbackName: string,
  skillPath: string
): SkillDetail {
  let name = fallbackName
  let description = ''
  let tags: string[] = []

  const frontmatterMatch = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1]
    const body = frontmatterMatch[2].trim()

    for (const line of yaml.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('name:')) {
        name = trimmed.slice(5).trim()
      } else if (trimmed.startsWith('description:')) {
        description = trimmed.slice(12).trim()
      } else if (trimmed.startsWith('tags:')) {
        const rawTags = trimmed.slice(5).trim()
        if (rawTags.startsWith('[') && rawTags.endsWith(']')) {
          tags = rawTags
            .slice(1, -1)
            .split(',')
            .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean)
        }
      }
    }

    return {
      name,
      description: description || `Skill ${name}`,
      tags,
      content: body || rawContent,
      path: skillPath
    }
  }

  // 无 frontmatter 时，提取第一个标题与后续第一段作为摘要
  const titleMatch = rawContent.match(/^#\s+(.+)$/m)
  if (titleMatch) {
    name = titleMatch[1].trim()
  }
  const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.startsWith('#'))
  description = lines[0] ?? `Skill ${name}`

  return {
    name,
    description,
    tags,
    content: rawContent,
    path: skillPath
  }
}

async function loadAllSkills(): Promise<SkillDetail[]> {
  const root = resolveRoot('downloads')
  const skillsDir = join(root, '.skills')
  const skillsMap = new Map<string, SkillDetail>()

  // 1. 载入内置技能作为基准
  for (const skill of BUILTIN_SKILLS) {
    skillsMap.set(skill.name, skill)
  }

  // 2. 探索本地 .skills 目录
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMd = join(skillsDir, entry.name, 'SKILL.md')
        try {
          const content = await readFile(skillMd, 'utf-8')
          const skill = parseSkillContent(content, entry.name, `.skills/${entry.name}/SKILL.md`)
          skillsMap.set(skill.name, skill)
        } catch {
          // ignore directory without SKILL.md
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const skillFile = join(skillsDir, entry.name)
        try {
          const content = await readFile(skillFile, 'utf-8')
          const baseName = entry.name.slice(0, -3)
          const skill = parseSkillContent(content, baseName, `.skills/${entry.name}`)
          skillsMap.set(skill.name, skill)
        } catch {
          // ignore read error
        }
      }
    }
  } catch {
    // .skills 目录不存在则仅使用内置技能
  }

  return Array.from(skillsMap.values())
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
