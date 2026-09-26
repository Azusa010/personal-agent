import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { resolveVikingUriWithinRoot } from '../capabilities/path-guard'
import { toPosix } from '../capabilities/roots'

export const VIKING_L0_FILE = '.abstract.md'
export const VIKING_L0_LEGACY_FILE = '.abstract'
export const VIKING_L1_FILE = '.overview.md'
export const VIKING_L1_LEGACY_FILE = '.overview'
export const VIKING_INDEX_FILE = 'INDEX.md'
export const VIKING_RELATIONS_FILE = 'relations.jsonl'

export const DEFAULT_VIKING_CATEGORIES = [
  'identity',
  'relationships',
  'projects',
  'knowledge',
  'raptor_trees'
] as const

export type DefaultVikingCategory = (typeof DEFAULT_VIKING_CATEGORIES)[number]

export interface VikingTreeNode {
  name: string
  uri: string
  isDirectory: boolean
  hasL0: boolean
  hasL1: boolean
  hasL2: boolean
  children?: VikingTreeNode[]
}

/**
 * 解析 Viking 本地存储根目录。
 * 优先级：customRoot 覆盖 > PERSONAL_AGENT_VIKING_ROOT 环境变量 > ~/.personal-agent/viking_store/
 */
export function resolveVikingStoreRoot(customRoot?: string): string {
  if (customRoot) {
    return toPosix(resolve(customRoot))
  }
  const fromEnv = process.env.PERSONAL_AGENT_VIKING_ROOT
  const base = fromEnv ? fromEnv : join(homedir(), '.personal-agent', 'viking_store')
  return toPosix(resolve(base))
}

/**
 * 校验 L0 摘要的有效性：
 * 1. 字符长度：严格控制在 1 到 150 字符以内（含 150，trim 后非空）。
 * 2. 核心特征标签：必须包含至少 3 个有效且唯一的标签（不区分大小写，去重计数 >= 3）。
 *    支持的标签书写方式包括：
 *    - 井号标签: #tag1 #tag2 #tag3
 *    - 中英文标签行: 标签: a, b, c 或 Tags: a, b, c 或 标签：a、b、c
 *    - 方括号标签: [tag1, tag2, tag3]
 *    - YAML Frontmatter: tags: [a, b, c] 或 tags:\n  - a\n  - b\n  - c
 *
 * @param content .abstract 文件的文本内容
 * @returns 满足规范返回 true，超长、无标签或标签不足 3 个返回 false
 */
export function validateAbstractLengthAndKeywords(content: string): boolean {
  const trim_content = content.trim()
  if (trim_content.length === 0 || trim_content.length > 150) {
    return false
  }

  const tag = new Set<string>()

  // 1. 井号标签
  const hashTagRegex = /#([a-zA-Z0-9_\u4e00-\u9fa5]+)/g
  let match: RegExpExecArray | null
  while ((match = hashTagRegex.exec(trim_content)) !== null) {
    tag.add(match[1].toLowerCase())
  }

  // 2. 中英文标签行
  const labelLineRegex = /(?:标签|Tags?)[:：]\s*([^\n]+)/gi
  while ((match = labelLineRegex.exec(trim_content)) !== null) {
    const labels = match[1].split(/[,、]/).map((l) => l.trim().toLowerCase())
    labels.forEach((l) => l && tag.add(l))
  }

  // 3. 方括号标签
  const bracketTagRegex = /\[([^\]]+)\]/g
  while ((match = bracketTagRegex.exec(trim_content)) !== null) {
    const labels = match[1].split(/[,、]/).map((l) => l.trim().toLowerCase())
    labels.forEach((l) => l && tag.add(l))
  }

  // 4. YAML Frontmatter 标签
  const yamlTagRegex = /tags:\s*(?:\[[^\]]*\]|(?:\n\s*-\s*[^\n]+)+)/gi
  while ((match = yamlTagRegex.exec(trim_content)) !== null) {
    const yamlContent = match[0]
    const yamlLabels = yamlContent.match(/-\s*([^\n]+)/g)
    if (yamlLabels) {
      yamlLabels.forEach((l) => {
        const label = l.replace(/-\s*/, '').trim().toLowerCase()
        if (label) tag.add(label)
      })
    }
  }

  return tag.size >= 3
}

/**
 * 初始化 Viking 维基存储目录结构与骨架模板。
 * 若指定目录或模板文件不存在，则自动补齐。
 */
export async function initVikingStore(storeRoot: string): Promise<void> {
  await mkdir(storeRoot, { recursive: true })

  const categoryTemplates: Record<
    DefaultVikingCategory,
    { title: string; abstractText: string; overviewText: string }
  > = {
    identity: {
      title: '用户身份画像与偏好',
      abstractText: '用户身份画像、交互偏好与核心事实摘要。 #身份 #偏好 #画像',
      overviewText: '# 身份画像与核心偏好概览\n记录用户核心事实、交互风格与长期配置。'
    },
    relationships: {
      title: '重要人物与人际关系',
      abstractText: '重要人物画像、组织协作与人际关系网络。 #人际 #同事 #协作',
      overviewText: '# 重要人物与人际关系概览\n记录协作关系、上下文实体消歧与联系网络。'
    },
    projects: {
      title: '历史项目与长期任务',
      abstractText: '开发项目背景、技术选型与任务脉络沉淀。 #项目 #架构 #工程',
      overviewText: '# 历史项目与长期任务概览\n记录关键工程演进、开发规划与里程碑。'
    },
    knowledge: {
      title: '领域知识与指令集',
      abstractText: '沉淀的计算机领域知识、系统架构与技术指令集。 #知识 #技术 #架构',
      overviewText: '# 领域知识与指令集概览\n记录架构设计、硬件指令、协议规约与技术细节。'
    },
    raptor_trees: {
      title: 'RAPTOR 树状递归索引',
      abstractText: '长文档分层聚类抽象树与递归摘要索引。 #RAPTOR #聚类 #索引',
      overviewText: '# RAPTOR 树状聚类索引概览\n维护从宏观摘要到微观 chunk 的自顶向下树状索引。'
    }
  }

  for (const cat of DEFAULT_VIKING_CATEGORIES) {
    const catDir = join(storeRoot, cat)
    await mkdir(catDir, { recursive: true })

    const tmpl = categoryTemplates[cat]
    const l0Path = join(catDir, VIKING_L0_FILE)
    const legacyL0Path = join(catDir, VIKING_L0_LEGACY_FILE)
    if (!existsSync(l0Path) && !existsSync(legacyL0Path)) {
      await writeFile(l0Path, tmpl.abstractText, 'utf-8')
    }

    const l1Path = join(catDir, VIKING_L1_FILE)
    const legacyL1Path = join(catDir, VIKING_L1_LEGACY_FILE)
    if (!existsSync(l1Path) && !existsSync(legacyL1Path)) {
      await writeFile(l1Path, tmpl.overviewText, 'utf-8')
    }

    const indexPath = join(catDir, VIKING_INDEX_FILE)
    if (!existsSync(indexPath)) {
      const indexContent = `# ${tmpl.title}\n\n- [${VIKING_L0_FILE}](${VIKING_L0_FILE}) - L0 摘要\n- [${VIKING_L1_FILE}](${VIKING_L1_FILE}) - L1 概览\n`
      await writeFile(indexPath, indexContent, 'utf-8')
    }
  }
}

/**
 * 辅助函数：根据 targetPath 是目录还是文件，解析 L0/L1/L2 目标文件路径。
 */
async function resolveTierFilePath(
  resolvedTarget: string,
  tier: 'L0' | 'L1' | 'L2'
): Promise<string> {
  let isDir = false
  if (existsSync(resolvedTarget)) {
    const s = await stat(resolvedTarget)
    isDir = s.isDirectory()
  } else {
    // 若不存在，根据是否有扩展名简单判断（无扩展名视为目录路径）
    isDir = !basename(resolvedTarget).includes('.')
  }

  if (tier === 'L0') {
    if (isDir) {
      const p = join(resolvedTarget, VIKING_L0_FILE)
      if (existsSync(p)) return p
      const leg = join(resolvedTarget, VIKING_L0_LEGACY_FILE)
      if (existsSync(leg)) return leg
      return p
    }
    const companion = `${resolvedTarget}.abstract.md`
    if (existsSync(companion)) return companion
    const legacyCompanion = `${resolvedTarget}.abstract`
    if (existsSync(legacyCompanion)) return legacyCompanion
    return join(dirname(resolvedTarget), VIKING_L0_FILE)
  }

  if (tier === 'L1') {
    if (isDir) {
      const p = join(resolvedTarget, VIKING_L1_FILE)
      if (existsSync(p)) return p
      const leg = join(resolvedTarget, VIKING_L1_LEGACY_FILE)
      if (existsSync(leg)) return leg
      return p
    }
    const companion = `${resolvedTarget}.overview.md`
    if (existsSync(companion)) return companion
    const legacyCompanion = `${resolvedTarget}.overview`
    if (existsSync(legacyCompanion)) return legacyCompanion
    return join(dirname(resolvedTarget), VIKING_L1_FILE)
  }

  // tier === 'L2'
  if (isDir) {
    return join(resolvedTarget, VIKING_INDEX_FILE)
  }
  return resolvedTarget
}

/**
 * 读取 Viking 维基条目的 L0 摘要 (.abstract)
 */
export async function readVikingL0(
  storeRoot: string,
  uri: string
): Promise<{ abstractText: string; isValid: boolean }> {
  const resolvedTarget = resolveVikingUriWithinRoot(uri, storeRoot)
  const targetFile = await resolveTierFilePath(resolvedTarget, 'L0')

  if (!existsSync(targetFile)) {
    throw new Error(`Viking L0 摘要文件不存在: ${uri} (文件: ${targetFile})`)
  }

  const text = await readFile(targetFile, 'utf-8')
  const isValid = validateAbstractLengthAndKeywords(text)
  return { abstractText: text, isValid }
}

/**
 * 读取 Viking 维基目录或条目的 L1 概览 (.overview)
 */
export async function readVikingL1(storeRoot: string, uri: string): Promise<string> {
  const resolvedTarget = resolveVikingUriWithinRoot(uri, storeRoot)
  const targetFile = await resolveTierFilePath(resolvedTarget, 'L1')

  if (!existsSync(targetFile)) {
    throw new Error(`Viking L1 概览文件不存在: ${uri} (文件: ${targetFile})`)
  }

  return await readFile(targetFile, 'utf-8')
}

/**
 * 读取 Viking 维基条目的 L2 原始正文 (*.md / INDEX.md)
 */
export async function readVikingL2(storeRoot: string, uri: string): Promise<string> {
  const resolvedTarget = resolveVikingUriWithinRoot(uri, storeRoot)
  const targetFile = await resolveTierFilePath(resolvedTarget, 'L2')

  if (!existsSync(targetFile)) {
    throw new Error(`Viking L2 正文文件不存在: ${uri} (文件: ${targetFile})`)
  }

  return await readFile(targetFile, 'utf-8')
}

/**
 * 写入或更新 Viking 维基条目的 L2 全文 (*.md)
 */
export async function writeVikingL2(
  storeRoot: string,
  uri: string,
  content: string
): Promise<{ bytesWritten: number; path: string }> {
  const resolvedTarget = resolveVikingUriWithinRoot(uri, storeRoot)
  const targetFile = await resolveTierFilePath(resolvedTarget, 'L2')

  await mkdir(dirname(targetFile), { recursive: true })
  await writeFile(targetFile, content, 'utf-8')
  const bytes = Buffer.byteLength(content, 'utf-8')

  return { bytesWritten: bytes, path: toPosix(targetFile) }
}

/**
 * 遍历列出 Viking 目录树结构
 */
export async function listVikingTree(
  storeRoot: string,
  uri = 'viking://'
): Promise<VikingTreeNode> {
  const resolvedTarget = resolveVikingUriWithinRoot(uri, storeRoot)

  async function buildNode(currentPath: string, currentUri: string): Promise<VikingTreeNode> {
    const s = await stat(currentPath)
    const isDir = s.isDirectory()

    if (!isDir) {
      return {
        name: basename(currentPath),
        uri: currentUri,
        isDirectory: false,
        hasL0: existsSync(`${currentPath}.abstract`),
        hasL1: existsSync(`${currentPath}.overview`),
        hasL2: true
      }
    }

    const entries = await readdir(currentPath, { withFileTypes: true })
    const hasL0 =
      existsSync(join(currentPath, VIKING_L0_FILE)) ||
      existsSync(join(currentPath, VIKING_L0_LEGACY_FILE))
    const hasL1 =
      existsSync(join(currentPath, VIKING_L1_FILE)) ||
      existsSync(join(currentPath, VIKING_L1_LEGACY_FILE))
    const hasL2 = existsSync(join(currentPath, VIKING_INDEX_FILE))

    const children: VikingTreeNode[] = []
    for (const entry of entries) {
      if (
        entry.name === VIKING_L0_FILE ||
        entry.name === VIKING_L0_LEGACY_FILE ||
        entry.name === VIKING_L1_FILE ||
        entry.name === VIKING_L1_LEGACY_FILE ||
        entry.name === VIKING_RELATIONS_FILE
      ) {
        continue
      }
      const childPath = join(currentPath, entry.name)
      const cleanUri = currentUri.endsWith('/') ? currentUri : `${currentUri}/`
      const childUri = `${cleanUri}${entry.name}`
      children.push(await buildNode(childPath, childUri))
    }

    return {
      name: basename(currentPath) || 'root',
      uri: currentUri,
      isDirectory: true,
      hasL0,
      hasL1,
      hasL2,
      children
    }
  }

  return await buildNode(resolvedTarget, uri)
}
