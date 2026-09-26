import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_VIKING_CATEGORIES,
  initVikingStore,
  listVikingTree,
  readVikingL0,
  readVikingL1,
  readVikingL2,
  resolveVikingStoreRoot,
  validateAbstractLengthAndKeywords,
  VIKING_L0_FILE,
  VIKING_L1_FILE,
  VIKING_INDEX_FILE,
  writeVikingL2
} from './viking-store'

describe('VikingStore', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pa-viking-test-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  describe('resolveVikingStoreRoot', () => {
    it('customRoot 优先解析', () => {
      const root = resolveVikingStoreRoot(tempRoot)
      expect(root).toBe(tempRoot.replace(/\\/g, '/'))
    })
  })

  describe('initVikingStore', () => {
    it('为所有默认分类创建目录以及三件套模板 (.abstract, .overview, INDEX.md)', async () => {
      await initVikingStore(tempRoot)

      for (const cat of DEFAULT_VIKING_CATEGORIES) {
        const catDir = join(tempRoot, cat)
        const l0 = await readFile(join(catDir, VIKING_L0_FILE), 'utf-8')
        const l1 = await readFile(join(catDir, VIKING_L1_FILE), 'utf-8')
        const idx = await readFile(join(catDir, VIKING_INDEX_FILE), 'utf-8')

        expect(l0.length).toBeGreaterThan(0)
        expect(l1.length).toBeGreaterThan(0)
        expect(idx).toContain(VIKING_L0_FILE)
      }
    })

    it('幂等初始化：已存在的自定义内容不被覆盖', async () => {
      await initVikingStore(tempRoot)
      const customIdentityL0 = '我的自定义身份摘要 #自定义 #标签 #测试'
      const l0Path = join(tempRoot, 'identity', VIKING_L0_FILE)
      await writeFile(l0Path, customIdentityL0, 'utf-8')

      // 再次调用 initVikingStore
      await initVikingStore(tempRoot)
      const l0Content = await readFile(l0Path, 'utf-8')
      expect(l0Content).toBe(customIdentityL0)
    })
  })

  describe('L0/L1/L2 渐进式读取与写入', () => {
    beforeEach(async () => {
      await initVikingStore(tempRoot)
    })

    it('readVikingL0 读取目录 L0 摘要', async () => {
      const res = await readVikingL0(tempRoot, 'viking://identity')
      expect(res.abstractText).toContain('用户身份画像')
    })

    it('readVikingL1 读取目录 L1 概览', async () => {
      const overview = await readVikingL1(tempRoot, 'viking://projects')
      expect(overview).toContain('历史项目与长期任务概览')
    })

    it('readVikingL2 目录 URI 默认读取 INDEX.md', async () => {
      const content = await readVikingL2(tempRoot, 'viking://knowledge')
      expect(content).toContain('领域知识与指令集')
    })

    it('writeVikingL2 写入新 L2 文档并由 readVikingL2 读取', async () => {
      const markdown = '# AVX-512 指令集\n包含 512 位宽向量运算。'
      const writeRes = await writeVikingL2(
        tempRoot,
        'viking://knowledge/cpu_architectures/avx512.md',
        markdown
      )

      expect(writeRes.bytesWritten).toBeGreaterThan(0)
      expect(writeRes.path).toContain('avx512.md')

      const readBack = await readVikingL2(
        tempRoot,
        'viking://knowledge/cpu_architectures/avx512.md'
      )
      expect(readBack).toBe(markdown)
    })

    it('非法路径或试图沙箱逃逸时直接拦截抛错', async () => {
      await expect(writeVikingL2(tempRoot, 'viking://../escape.md', 'hacked')).rejects.toThrow()
    })

    it('文件不存在时抛出清晰的错误', async () => {
      await expect(readVikingL2(tempRoot, 'viking://knowledge/non_existent.md')).rejects.toThrow(
        'Viking L2 正文文件不存在'
      )
    })
  })

  describe('listVikingTree 目录树漫游', () => {
    it('正确递归生成包含 L0/L1/L2 标记的目录树', async () => {
      await initVikingStore(tempRoot)
      await writeVikingL2(tempRoot, 'viking://identity/profile.md', '# 核心画像\n热爱编程')

      const tree = await listVikingTree(tempRoot, 'viking://')
      expect(tree.isDirectory).toBe(true)
      expect(tree.children?.length).toBe(DEFAULT_VIKING_CATEGORIES.length)

      const identityNode = tree.children?.find((c) => c.name === 'identity')
      expect(identityNode).toBeDefined()
      expect(identityNode?.hasL0).toBe(true)
      expect(identityNode?.hasL1).toBe(true)
      expect(identityNode?.hasL2).toBe(true)

      const profileNode = identityNode?.children?.find((c) => c.name === 'profile.md')
      expect(profileNode).toBeDefined()
      expect(profileNode?.isDirectory).toBe(false)
      expect(profileNode?.hasL2).toBe(true)
    })
  })

  describe('validateAbstractLengthAndKeywords (项目主人陪练点)', () => {
    it('合法摘要：<= 150 字符且带至少 3 个井号标签 (#tag) 返回 true', () => {
      const validL0 = '用户偏好使用 TypeScript 进行严格类型检查。 #偏好 #TypeScript #前端'
      expect(validateAbstractLengthAndKeywords(validL0)).toBe(true)
    })

    it('合法摘要：中文标签声明格式 (标签: a, b, c) 返回 true', () => {
      const validL0 = '系统架构与离线模型规划。 标签: 架构, 离线模型, 规划'
      expect(validateAbstractLengthAndKeywords(validL0)).toBe(true)
    })

    it('合法摘要：英文 Tags 或方括号声明格式返回 true', () => {
      const validL0 = 'OpenViking 本地存储规范与三层渐进加载。 Tags: viking, storage, l0-l2'
      expect(validateAbstractLengthAndKeywords(validL0)).toBe(true)
    })

    it('合法摘要：YAML frontmatter tags 声明格式返回 true', () => {
      const validL0 = '---\ntags: [agent, memory, wiki]\n---\n维基网络核心摘要。'
      expect(validateAbstractLengthAndKeywords(validL0)).toBe(true)
    })

    it('有效标签不足 3 个时返回 false', () => {
      const invalidL0 = '仅有两个标签的摘要。 #标签一 #标签二'
      expect(validateAbstractLengthAndKeywords(invalidL0)).toBe(false)
    })

    it('标签存在重复导致去重后不足 3 个时返回 false', () => {
      const invalidL0 = '重复标签测试。 #架构 #架构 #测试'
      expect(validateAbstractLengthAndKeywords(invalidL0)).toBe(false)
    })

    it('超过 150 字符的摘要必须被拦截返回 false', () => {
      const longText =
        '这是一个非常冗长且超出了系统规定长度的摘要。'.repeat(8) + ' #标签1 #标签2 #标签3'
      expect(longText.length).toBeGreaterThan(150)
      expect(validateAbstractLengthAndKeywords(longText)).toBe(false)
    })

    it('空字符串或纯空白返回 false', () => {
      expect(validateAbstractLengthAndKeywords('')).toBe(false)
      expect(validateAbstractLengthAndKeywords('   \n  \t ')).toBe(false)
    })

    it('刚好 150 字符且满足 3 个标签时返回 true', () => {
      const base = '#a #b #c '
      const pad = '一'.repeat(150 - base.length)
      const exact150 = base + pad
      expect(exact150.length).toBe(150)
      expect(validateAbstractLengthAndKeywords(exact150)).toBe(true)
    })
  })
})
