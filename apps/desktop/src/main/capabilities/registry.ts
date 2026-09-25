import {
  type CapabilityDescriptor,
  type CapabilityId,
  type CapabilityKind
} from '@personal-agent/protocol'

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
  }
] as const satisfies readonly CapabilityDescriptor[]

export type CapabilityName = CapabilityId

export function listCapabilities(): readonly CapabilityDescriptor[] {
  return CAPABILITIES
}

export function listByKind(kind: CapabilityKind): readonly CapabilityDescriptor[] {
  return CAPABILITIES.filter((c) => c.kind === kind)
}

export function findCapability(name: string): CapabilityDescriptor | null {
  return CAPABILITIES.find((c) => c.name === name) ?? null
}
