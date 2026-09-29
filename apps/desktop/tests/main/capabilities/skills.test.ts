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
import {
  skillSearchPlugin,
  skillReadPlugin,
  clearSkillsCache,
  loadAllSkills,
  parseSkillContent
} from '../../../src/main/capabilities/plugins/skills'
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

  describe('Workspace Skills Discovery & Hierarchy Overrides (TASK-A2)', () => {
    const testWsRoot = join(root, 'test_ws_space')
    const testWsSkillsDir = join(testWsRoot, '.agent', 'skills')
    let origWsEnv: string | undefined

    beforeEach(async () => {
      origWsEnv = process.env['PERSONAL_AGENT_WORKSPACE_DIR']
      process.env['PERSONAL_AGENT_WORKSPACE_DIR'] = testWsRoot
      await rm(testWsRoot, { recursive: true, force: true }).catch(() => {})
      await rm(skillsDir, { recursive: true, force: true }).catch(() => {})
    })

    afterEach(async () => {
      if (origWsEnv !== undefined) {
        process.env['PERSONAL_AGENT_WORKSPACE_DIR'] = origWsEnv
      } else {
        delete process.env['PERSONAL_AGENT_WORKSPACE_DIR']
      }
      await rm(testWsRoot, { recursive: true, force: true }).catch(() => {})
      await rm(skillsDir, { recursive: true, force: true }).catch(() => {})
    })

    it('skill_search: 能够动态发现 workspace 根目录下 .agent/skills/ 中的自举技能', async () => {
      const logParserDir = join(testWsSkillsDir, 'log-parser')
      await mkdir(logParserDir, { recursive: true })
      const skillContent = `---
name: log-parser
description: 自定义日志解析与字段提取工具
tags: [log, parser, adapter]
---
# Log Parser
使用方法：python .agent/tools/log_parser.py
`
      await writeFile(join(logParserDir, 'SKILL.md'), skillContent, 'utf-8')

      const bindResult = await skillSearchPlugin.bindArguments({ query: 'log' })
      expect(bindResult.ok).toBe(true)
      if (!bindResult.ok) return

      const call: AuthorizedCall = {
        callId: 'call-ws-1',
        taskId: 'task-ws-1',
        capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
        bound: bindResult.bound
      }

      const outcome = (await skillSearchPlugin.execute(call, {})) as unknown as SkillSearchResult
      expect(outcome.ok).toBe(true)
      const found = outcome.skills.find((s: SkillMetadata) => s.name === 'log-parser')
      expect(found).toBeDefined()
      expect(found?.description).toBe('自定义日志解析与字段提取工具')
      expect(found?.tags).toContain('adapter')
      expect(found?.path).toBe('.agent/skills/log-parser/SKILL.md')
    })

    it('skill_read: 能够按需读取 workspace 根目录下 .agent/skills/ 中的自举技能全文', async () => {
      const apiAdapterDir = join(testWsSkillsDir, 'api-adapter')
      await mkdir(apiAdapterDir, { recursive: true })
      const skillContent = `---
name: api-adapter
description: 动态第三方 API 响应适配器
tags: [api, adapter, http]
---
# API Adapter
详细使用说明：处理未声明字段并归一化输出。
`
      await writeFile(join(apiAdapterDir, 'SKILL.md'), skillContent, 'utf-8')

      const bindResult = await skillReadPlugin.bindArguments({ name: 'api-adapter' })
      expect(bindResult.ok).toBe(true)
      if (!bindResult.ok) return

      const call: AuthorizedCall = {
        callId: 'call-ws-2',
        taskId: 'task-ws-1',
        capability: skillReadPlugin.descriptor as CapabilityDescriptor,
        bound: bindResult.bound
      }

      const outcome = (await skillReadPlugin.execute(call, {})) as unknown as SkillReadResult
      expect(outcome.ok).toBe(true)
      expect(outcome.name).toBe('api-adapter')
      expect(outcome.content).toContain('处理未声明字段并归一化输出')
      expect(outcome.path).toBe('.agent/skills/api-adapter/SKILL.md')
      expect(outcome.tags).toEqual(['api', 'adapter', 'http'])
    })

    it('多层技能覆盖优先级：workspace .agent/skills 覆盖 downloads .skills 覆盖内置技能', async () => {
      // 1. 在 downloads/.skills 建立同名技能覆盖内置 data-cleaner
      const dlDir = join(skillsDir, 'data-cleaner')
      await mkdir(dlDir, { recursive: true })
      await writeFile(
        join(dlDir, 'SKILL.md'),
        `---
name: data-cleaner
description: downloads 全局自定义清洗技能
tags: [downloads, custom]
---
# Downloads Data Cleaner
这是来自 downloads 的覆盖版本。
`,
        'utf-8'
      )

      // 2. 在 workspace/.agent/skills 建立同名技能再次覆盖
      const wsDir = join(testWsSkillsDir, 'data-cleaner')
      await mkdir(wsDir, { recursive: true })
      await writeFile(
        join(wsDir, 'SKILL.md'),
        `---
name: data-cleaner
description: workspace 项目级自举清洗技能
tags: [workspace, custom]
---
# Workspace Data Cleaner
这是来自 workspace 的最高优先级版本。
`,
        'utf-8'
      )

      const bindResult = await skillReadPlugin.bindArguments({ name: 'data-cleaner' })
      expect(bindResult.ok).toBe(true)
      if (!bindResult.ok) return

      const call: AuthorizedCall = {
        callId: 'call-ws-3',
        taskId: 'task-ws-1',
        capability: skillReadPlugin.descriptor as CapabilityDescriptor,
        bound: bindResult.bound
      }

      // 验证 workspace 优先级最高
      const outcome1 = (await skillReadPlugin.execute(call, {})) as unknown as SkillReadResult
      expect(outcome1.ok).toBe(true)
      expect(outcome1.description).toBe('workspace 项目级自举清洗技能')
      expect(outcome1.content).toContain('来自 workspace 的最高优先级版本')
      expect(outcome1.path).toBe('.agent/skills/data-cleaner/SKILL.md')

      // 删除 workspace 级后，次级 downloads 生效
      await rm(wsDir, { recursive: true, force: true })
      const outcome2 = (await skillReadPlugin.execute(call, {})) as unknown as SkillReadResult
      expect(outcome2.ok).toBe(true)
      expect(outcome2.description).toBe('downloads 全局自定义清洗技能')
      expect(outcome2.content).toContain('来自 downloads 的覆盖版本')
      expect(outcome2.path).toBe('.skills/data-cleaner/SKILL.md')

      // 删除 downloads 级后，回退至内置技能
      await rm(dlDir, { recursive: true, force: true })
      const outcome3 = (await skillReadPlugin.execute(call, {})) as unknown as SkillReadResult
      expect(outcome3.ok).toBe(true)
      expect(outcome3.description).toContain('规范化表格与 CSV 数据')
      expect(outcome3.path).toBe('builtin://data-cleaner')
    })

    it('workspace 目录不存在或未配置时静默降级，不抛出异常', async () => {
      // 指向不存在的目录
      process.env['PERSONAL_AGENT_WORKSPACE_DIR'] = join(root, 'non_existent_folder_abc_123')

      const bindResult = await skillSearchPlugin.bindArguments({ query: '*' })
      expect(bindResult.ok).toBe(true)
      if (!bindResult.ok) return

      const call: AuthorizedCall = {
        callId: 'call-ws-4',
        taskId: 'task-ws-1',
        capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
        bound: bindResult.bound
      }

      // 静默降级，不崩溃，正常返回内置技能
      const outcome = (await skillSearchPlugin.execute(call, {})) as unknown as SkillSearchResult
      expect(outcome.ok).toBe(true)
      expect(outcome.skills.length).toBeGreaterThan(0)
    })
  })

  describe('Enhanced Skill Discovery & Robustness (GRILL-ME enhancements)', () => {
    const wsRoot = join(root, 'test_ws_robustness')
    const wsSkillsDir = join(wsRoot, '.skills')
    const wsAgentSkillsDir = join(wsRoot, '.agent', 'skills')
    let origWsEnv: string | undefined

    beforeEach(async () => {
      clearSkillsCache()
      origWsEnv = process.env['PERSONAL_AGENT_WORKSPACE_DIR']
      process.env['PERSONAL_AGENT_WORKSPACE_DIR'] = wsRoot
      await rm(wsRoot, { recursive: true, force: true }).catch(() => {})
      await rm(skillsDir, { recursive: true, force: true }).catch(() => {})
    })

    afterEach(async () => {
      clearSkillsCache()
      if (origWsEnv !== undefined) {
        process.env['PERSONAL_AGENT_WORKSPACE_DIR'] = origWsEnv
      } else {
        delete process.env['PERSONAL_AGENT_WORKSPACE_DIR']
      }
      await rm(wsRoot, { recursive: true, force: true }).catch(() => {})
      await rm(skillsDir, { recursive: true, force: true }).catch(() => {})
    })

    it('parseSkillContent: 稳健解析包含 UTF-8 BOM、引号包裹与多行 YAML tags 的 Frontmatter', () => {
      const content =
        '\uFEFF\n\n---\nname: "quoted-skill"\ndescription: \'带单引号的描述\'\ntags:\n  - tag-one\n  - "tag-two"\n---\n# Quoted Skill Body\n正文内容'
      const skill = parseSkillContent(content, 'fallback-name', 'path/to/skill.md')

      expect(skill.name).toBe('quoted-skill')
      expect(skill.description).toBe('带单引号的描述')
      expect(skill.tags).toEqual(['tag-one', 'tag-two'])
      expect(skill.content).toContain('正文内容')
      expect(skill.content).not.toContain('quoted-skill')
    })

    it('parseSkillContent: 无 Frontmatter 时保持 fallbackName 为 slug 并提取标题与第一段正文', () => {
      const content = '# Title With Space And Chinese\n\n这是第一段有效正文描述。\n\n这是第二段。'
      const skill = parseSkillContent(content, 'clean-slug-name', 'path/to/slug.md')

      expect(skill.name).toBe('clean-slug-name')
      expect(skill.description).toContain('Title With Space And Chinese')
      expect(skill.description).toContain('这是第一段有效正文描述')
      expect(skill.tags).toEqual([])
    })

    it('skill_search: 自动忽略 README.md、LICENSE.md 等通用文档及隐藏文件', async () => {
      await mkdir(skillsDir, { recursive: true })
      await writeFile(join(skillsDir, 'README.md'), '# Readme Document\nNot a skill', 'utf-8')
      await writeFile(join(skillsDir, 'LICENSE.md'), '# License\nMIT', 'utf-8')
      await writeFile(join(skillsDir, '.hidden-skill.md'), '# Hidden\nSecret', 'utf-8')
      await writeFile(
        join(skillsDir, 'valid-standalone.md'),
        '---\nname: valid-standalone\ndescription: 有效的独立技能文件\n---\n# Valid Standalone',
        'utf-8'
      )

      const bindResult = await skillSearchPlugin.bindArguments({ query: '*' })
      expect(bindResult.ok).toBe(true)
      if (!bindResult.ok) return

      const call: AuthorizedCall = {
        callId: 'call-filter-1',
        taskId: 'task-filter-1',
        capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
        bound: bindResult.bound
      }

      const outcome = (await skillSearchPlugin.execute(call, {})) as unknown as SkillSearchResult
      expect(outcome.ok).toBe(true)
      const names = outcome.skills.map((s) => s.name.toLowerCase())
      expect(names).not.toContain('readme')
      expect(names).not.toContain('license')
      expect(names).not.toContain('.hidden-skill')
      expect(names).toContain('valid-standalone')
    })

    it('skill_search: 子目录中兼容匹配小写的 skill.md', async () => {
      const dir = join(skillsDir, 'case-insensitive-skill')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'skill.md'),
        '---\nname: case-insensitive-skill\ndescription: 采用小写 skill.md 命名的技能\ntags: [case, test]\n---\n# Lowercase Skill',
        'utf-8'
      )

      const bindResult = await skillSearchPlugin.bindArguments({ query: 'case-insensitive' })
      expect(bindResult.ok).toBe(true)
      if (!bindResult.ok) return

      const call: AuthorizedCall = {
        callId: 'call-case-1',
        taskId: 'task-case-1',
        capability: skillSearchPlugin.descriptor as CapabilityDescriptor,
        bound: bindResult.bound
      }

      const outcome = (await skillSearchPlugin.execute(call, {})) as unknown as SkillSearchResult
      expect(outcome.ok).toBe(true)
      const found = outcome.skills.find((s) => s.name === 'case-insensitive-skill')
      expect(found).toBeDefined()
      expect(found?.path).toBe('.skills/case-insensitive-skill/skill.md')
    })

    it('workspace 目录发现: 支持 workspace/.skills 并能被 workspace/.agent/skills 覆盖', async () => {
      // 1. 在 workspace/.skills 创建技能 A
      await mkdir(join(wsSkillsDir, 'shared-tool'), { recursive: true })
      await writeFile(
        join(wsSkillsDir, 'shared-tool', 'SKILL.md'),
        '---\nname: shared-tool\ndescription: 来自 workspace/.skills 的版本\n---\n# Shared Tool V1',
        'utf-8'
      )

      // 并在 workspace/.skills 创建独有技能 B
      await mkdir(join(wsSkillsDir, 'workspace-plain-only'), { recursive: true })
      await writeFile(
        join(wsSkillsDir, 'workspace-plain-only', 'SKILL.md'),
        '---\nname: workspace-plain-only\ndescription: 仅在 workspace/.skills 中存在的技能\n---\n# Plain Only',
        'utf-8'
      )

      // 2. 在 workspace/.agent/skills 创建同名技能 A（高优先级覆盖）
      await mkdir(join(wsAgentSkillsDir, 'shared-tool'), { recursive: true })
      await writeFile(
        join(wsAgentSkillsDir, 'shared-tool', 'SKILL.md'),
        '---\nname: shared-tool\ndescription: 来自 workspace/.agent/skills 的覆盖版本\n---\n# Shared Tool V2',
        'utf-8'
      )

      // 读取 shared-tool 应该命中 .agent/skills 的覆盖版本
      const bindRead1 = await skillReadPlugin.bindArguments({ name: 'shared-tool' })
      expect(bindRead1.ok).toBe(true)
      if (!bindRead1.ok) return

      const call1: AuthorizedCall = {
        callId: 'call-ws-cover-1',
        taskId: 'task-ws-cover-1',
        capability: skillReadPlugin.descriptor as CapabilityDescriptor,
        bound: bindRead1.bound
      }
      const outcome1 = (await skillReadPlugin.execute(call1, {})) as unknown as SkillReadResult
      expect(outcome1.ok).toBe(true)
      expect(outcome1.description).toBe('来自 workspace/.agent/skills 的覆盖版本')
      expect(outcome1.path).toBe('.agent/skills/shared-tool/SKILL.md')

      // 读取 workspace-plain-only 应该正常发现
      const bindRead2 = await skillReadPlugin.bindArguments({ name: 'workspace-plain-only' })
      expect(bindRead2.ok).toBe(true)
      if (!bindRead2.ok) return

      const call2: AuthorizedCall = {
        callId: 'call-ws-cover-2',
        taskId: 'task-ws-cover-1',
        capability: skillReadPlugin.descriptor as CapabilityDescriptor,
        bound: bindRead2.bound
      }
      const outcome2 = (await skillReadPlugin.execute(call2, {})) as unknown as SkillReadResult
      expect(outcome2.ok).toBe(true)
      expect(outcome2.description).toBe('仅在 workspace/.skills 中存在的技能')
      expect(outcome2.path).toBe('.skills/workspace-plain-only/SKILL.md')
    })

    it('缓存与失效: 重复加载命中内存缓存，新增/变更文件或主动 clearSkillsCache 时即时重载', async () => {
      // 1. 首次加载
      const firstLoad = await loadAllSkills()
      // 2. 紧接着再次加载，对象引用相同（命中缓存）
      const secondLoad = await loadAllSkills()
      expect(firstLoad).toBe(secondLoad)

      // 3. 在磁盘中新建一个技能文件，指纹改变
      await mkdir(join(wsSkillsDir, 'cached-new-skill'), { recursive: true })
      await writeFile(
        join(wsSkillsDir, 'cached-new-skill', 'SKILL.md'),
        '---\nname: cached-new-skill\ndescription: 动态新增的技能\n---\n# New Skill',
        'utf-8'
      )

      // 4. 第三次加载，指纹改变导致缓存自动失效，重新读取
      const thirdLoad = await loadAllSkills()
      expect(thirdLoad).not.toBe(secondLoad)
      const foundNew = thirdLoad.find((s) => s.name === 'cached-new-skill')
      expect(foundNew).toBeDefined()

      // 5. 显式调用 clearSkillsCache
      const beforeClear = await loadAllSkills()
      clearSkillsCache()
      const afterClear = await loadAllSkills()
      expect(beforeClear).not.toBe(afterClear)
    })
  })
})
