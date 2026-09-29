import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  CapabilityDescriptor,
  SkillMetadata,
  SkillReadResult,
  SkillSearchResult
} from '@personal-agent/protocol'

import { resolveRoot } from '../../../src/main/capabilities/roots'
import { skillSearchPlugin, skillReadPlugin } from '../../../src/main/capabilities/plugins/skills'
import type { AuthorizedCall } from '../../../src/main/capabilities/plugin'

describe('Skill Progressive Disclosure Plugins (skill_search & skill_read)', () => {
  const root = resolveRoot('downloads')
  const skillsDir = join(root, '.skills')

  beforeEach(async () => {
    await rm(skillsDir, { recursive: true, force: true }).catch(() => {})
  })

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true }).catch(() => {})
  })

  it('skill_search: 默认可检索到内置技能，返回轻量元数据（无正文）', async () => {
    const bindResult = await skillSearchPlugin.bindArguments({ query: 'pdf' })
    expect(bindResult.ok).toBe(true)
    if (!bindResult.ok) return

    const call: AuthorizedCall = {
      callId: 'call-1',
      taskId: 'task-1',
      capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
      bound: bindResult.bound
    }

    const outcome = (await skillSearchPlugin.execute(call, {})) as unknown as SkillSearchResult
    expect(outcome.ok).toBe(true)
    expect(outcome.skills.length).toBeGreaterThan(0)
    const pdfSkill = outcome.skills.find((s: SkillMetadata) => s.name === 'pdf-table-extractor')
    expect(pdfSkill).toBeDefined()
    expect(pdfSkill?.tags).toContain('pdf')
    // 轻量元数据中不应包含大型 content 正文，避免 KV Cache 污染
    expect('content' in (pdfSkill ?? {})).toBe(false)
  })

  it('skill_search: 支持 tag 过滤与 maxResults 限制', async () => {
    const bindResult = await skillSearchPlugin.bindArguments({
      query: '*',
      tag: 'data',
      maxResults: 1
    })
    expect(bindResult.ok).toBe(true)
    if (!bindResult.ok) return

    const call: AuthorizedCall = {
      callId: 'call-2',
      taskId: 'task-1',
      capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
      bound: bindResult.bound
    }

    const outcome = (await skillSearchPlugin.execute(call, {})) as unknown as SkillSearchResult
    expect(outcome.ok).toBe(true)
    expect(outcome.skills).toHaveLength(1)
    expect(outcome.skills[0].tags).toContain('data')
  })

  it('skill_search: 能够动态发现本地 .skills 目录下的自定义技能', async () => {
    const customDir = join(skillsDir, 'stock-analyzer')
    await mkdir(customDir, { recursive: true })
    const skillContent = `---
name: stock-analyzer
description: 股票财务报表与估值模型分析技能
tags: [finance, stock, valuation]
---
# Stock Analyzer
详细操作指令：加载 EPS 与 PE 比例进行横向对标。
`
    await writeFile(join(customDir, 'SKILL.md'), skillContent, 'utf-8')

    const bindResult = await skillSearchPlugin.bindArguments({ query: 'valuation' })
    expect(bindResult.ok).toBe(true)
    if (!bindResult.ok) return

    const call: AuthorizedCall = {
      callId: 'call-3',
      taskId: 'task-1',
      capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
      bound: bindResult.bound
    }

    const outcome = (await skillSearchPlugin.execute(call, {})) as unknown as SkillSearchResult
    expect(outcome.ok).toBe(true)
    const customSkill = outcome.skills.find((s: SkillMetadata) => s.name === 'stock-analyzer')
    expect(customSkill).toBeDefined()
    expect(customSkill?.description).toBe('股票财务报表与估值模型分析技能')
    expect(customSkill?.tags).toContain('stock')
  })

  it('skill_read: 按需加载内置 Skill 完整指令', async () => {
    const bindResult = await skillReadPlugin.bindArguments({ name: 'code-refactoring' })
    expect(bindResult.ok).toBe(true)
    if (!bindResult.ok) return

    const call: AuthorizedCall = {
      callId: 'call-4',
      taskId: 'task-1',
      capability: skillReadPlugin.descriptor as CapabilityDescriptor,
      bound: bindResult.bound
    }

    const outcome = (await skillReadPlugin.execute(call, {})) as unknown as SkillReadResult
    expect(outcome.ok).toBe(true)
    expect(outcome.name).toBe('code-refactoring')
    expect(outcome.content).toContain('代码重构')
    expect(outcome.content).toContain('CapabilityPlugin')
  })

  it('skill_read: 加载自定义本地 Skill 完整正文 (SKILL.md)', async () => {
    const customDir = join(skillsDir, 'local-translator')
    await mkdir(customDir, { recursive: true })
    const customMd = `---
name: local-translator
description: 本地多语言术语一致性翻译
tags: [i18n, translation]
---
# Local Translator
请严格按照词汇表将专有名词进行规范翻译。
`
    await writeFile(join(customDir, 'SKILL.md'), customMd, 'utf-8')

    const bindResult = await skillReadPlugin.bindArguments({ name: 'local-translator' })
    expect(bindResult.ok).toBe(true)
    if (!bindResult.ok) return

    const call: AuthorizedCall = {
      callId: 'call-5',
      taskId: 'task-1',
      capability: skillReadPlugin.descriptor as CapabilityDescriptor,
      bound: bindResult.bound
    }

    const outcome = (await skillReadPlugin.execute(call, {})) as unknown as SkillReadResult
    expect(outcome.ok).toBe(true)
    expect(outcome.name).toBe('local-translator')
    expect(outcome.content).toContain('请严格按照词汇表将专有名词进行规范翻译')
    expect(outcome.tags).toEqual(['i18n', 'translation'])
  })

  it('skill_read: 找不到指定 Skill 时返回明确失败', async () => {
    const bindResult = await skillReadPlugin.bindArguments({ name: 'non-existent-skill' })
    expect(bindResult.ok).toBe(true)
    if (!bindResult.ok) return

    const call: AuthorizedCall = {
      callId: 'call-6',
      taskId: 'task-1',
      capability: skillReadPlugin.descriptor as CapabilityDescriptor,
      bound: bindResult.bound
    }

    const outcome = (await skillReadPlugin.execute(call, {})) as unknown as {
      ok: boolean
      reason?: string
    }
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('non-existent-skill')
  })
})
