export type CapabilityKind = 'READ' | 'WRITE'

export interface CapabilityDescriptor {
  name: string
  kind: CapabilityKind
  description: string
}

export const CAPABILITIES = [
  {
    name: 'filesystem.list',
    kind: 'READ',
    description: '列出授权根目录下的条目'
  },
  {
    name: 'document.extract_pdf',
    kind: 'READ',
    description: '提取 PDF 每页文本与页码'
  },
  {
    name: 'filesystem.create_dir',
    kind: 'WRITE',
    description: '在授权根目录下创建子目录'
  },
  {
    name: 'filesystem.move',
    kind: 'WRITE',
    description: '在授权根目录内移动文件'
  },
  {
    name: 'scheduler.create',
    kind: 'WRITE',
    description: '创建 Reminder'
  },
  {
    name: 'notification.send',
    kind: 'WRITE',
    description: '发送系统通知'
  }
] as const satisfies readonly CapabilityDescriptor[]

export type CapabilityName = (typeof CAPABILITIES)[number]['name']

export function listCapabilities(): readonly CapabilityDescriptor[] {
  return CAPABILITIES
}

export function listByKind(kind: CapabilityKind): readonly CapabilityDescriptor[] {
  return CAPABILITIES.filter((c) => c.kind === kind)
}

export function findCapability(name: string): CapabilityDescriptor | null {
  return CAPABILITIES.find((c) => c.name === name) ?? null
}
