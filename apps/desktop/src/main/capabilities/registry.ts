import {
  type CapabilityDescriptor,
  type CapabilityId,
  type CapabilityKind
} from '@personal-agent/protocol'
import { getCapabilityPlugin, listCapabilityPlugins } from './plugins'

export type { CapabilityDescriptor, CapabilityKind }

export const CAPABILITIES = [
  {
    name: 'filesystem_list',
    kind: 'READ',
    description: '列出授权根目录下的条目'
  },
  {
    name: 'document_extract_pdf',
    kind: 'READ',
    description: '提取 PDF 每页文本与页码'
  },
  {
    name: 'read_document',
    kind: 'READ',
    description: '多格式统一文档读取器，提取逐页文本并支持分页与字符限制 (PDF/Word/Markdown/Text)'
  },
  {
    name: 'file_search',
    kind: 'READ',
    description: '跨平台文件与内容检索，支持文件名通配符及纯文本/正则行检索'
  },
  {
    name: 'knowledge_search',
    kind: 'READ',
    description: '在知识库中进行混合语义与关键词全文检索'
  },
  {
    name: 'user_memory_search',
    kind: 'READ',
    description: '在用户记忆库中进行语义与全文检索（支持时间切片与实体消歧）'
  },
  {
    name: 'viking_read_l0',
    kind: 'READ',
    description: '读取 Viking 维基条目的 L0 摘要 (.abstract)'
  },
  {
    name: 'viking_read_l1',
    kind: 'READ',
    description: '读取 Viking 维基目录的 L1 概览 (.overview)'
  },
  {
    name: 'viking_read_l2',
    kind: 'READ',
    description: '读取 Viking 维基条目的 L2 全文 (*.md)'
  },
  {
    name: 'skill_search',
    kind: 'READ',
    description: '按关键词或标签检索 Agent Skills 目录，仅返回轻量元数据以保护上下文与 KV Cache'
  },
  {
    name: 'skill_read',
    kind: 'READ',
    description: '按需加载指定 Skill 的完整指令正文 (SKILL.md)，实现渐进式披露'
  },
  {
    name: 'web_search',
    kind: 'READ',
    description: '使用 Tavily 搜索引擎执行实时网络搜索，返回结构化网页标题、链接、摘要及答案'
  },
  {
    name: 'file_read',
    kind: 'READ',
    description: '读取指定文件内容，支持按起始行号与结束行号分页读取，每行自带行号前缀'
  },
  {
    name: 'filesystem_create_dir',
    kind: 'WRITE',
    description: '在授权根目录下创建子目录'
  },
  {
    name: 'filesystem_move',
    kind: 'WRITE',
    description: '在授权根目录内移动文件'
  },
  {
    name: 'file_write',
    kind: 'WRITE',
    description: '在工作区内写入或完全覆盖文件，自动创建父级目录'
  },
  {
    name: 'file_edit',
    kind: 'WRITE',
    description: '在现有文件中进行精准单块局部修改，Old String 必须在文件中全局唯一存在'
  },
  {
    name: 'scheduler_create',
    kind: 'WRITE',
    description: '创建 Reminder'
  },
  {
    name: 'notification_send',
    kind: 'WRITE',
    description: '发送系统通知'
  },
  {
    name: 'terminal_execute',
    kind: 'WRITE',
    description: '在安全工作目录下执行终端命令行'
  },
  {
    name: 'code_interpreter',
    kind: 'WRITE',
    description: '在隔离沙盒内执行 Python 代码段，用于复杂计算、批量数据转换及工具编排'
  },
  {
    name: 'viking_write_l2',
    kind: 'WRITE',
    description: '写入或更新 Viking 维基条目的 L2 全文 (*.md)'
  }
] as const satisfies readonly CapabilityDescriptor[]

export type CapabilityName = CapabilityId

export function listCapabilities(): readonly CapabilityDescriptor[] {
  const plugins = listCapabilityPlugins()
  if (plugins.length > 0) {
    return plugins.map((p) => p.descriptor as CapabilityDescriptor)
  }
  return CAPABILITIES
}

export function listByKind(kind: CapabilityKind): readonly CapabilityDescriptor[] {
  return listCapabilities().filter((c) => c.kind === kind)
}

export function findCapability(name: string): CapabilityDescriptor | null {
  const plugin = getCapabilityPlugin(name)
  if (plugin !== undefined) {
    return plugin.descriptor as CapabilityDescriptor
  }
  return CAPABILITIES.find((c) => c.name === name) ?? null
}
