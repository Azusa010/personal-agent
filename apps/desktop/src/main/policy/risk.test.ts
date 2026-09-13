import { describe, expect, it } from 'vitest'

import type { CapabilityDescriptor } from '@personal-agent/protocol'

import { listByKind, listCapabilities } from '../capabilities/registry'
import { assessRisk } from './risk'

function descriptor(name: string, kind: 'READ' | 'WRITE'): CapabilityDescriptor {
  return { name, kind, description: '测试用描述' } as CapabilityDescriptor
}

describe('assessRisk：两档判定', () => {
  it('READ -> NONE', () => {
    expect(assessRisk(descriptor('filesystem.list', 'READ')).level).toBe('NONE')
  })

  it('WRITE -> PERMISSION_REQUIRED', () => {
    expect(assessRisk(descriptor('filesystem.move', 'WRITE')).level).toBe('PERMISSION_REQUIRED')
  })

  it('reason 带能力名：它是 timeline 上唯一能看懂「为什么被拦」的字段', () => {
    const read = assessRisk(descriptor('filesystem.list', 'READ'))
    const write = assessRisk(descriptor('filesystem.move', 'WRITE'))

    expect(read.reason).toContain('filesystem.list')
    expect(write.reason).toContain('filesystem.move')
    // 两档的 reason 必须能区分开。都写「无风险」的话，事后看日志
    // 分不清是判成了 READ 还是压根没判。
    expect(write.reason).not.toBe(read.reason)
  })

  it('判定只看 kind，不看能力名', () => {
    // 名字里带 delete 但 kind 是 READ 就仍然是 NONE：registry 是唯一事实来源，
    // 靠名字猜风险等于把 SEC-007 的约束从「不许注册」降级成「不许叫这个名字」。
    expect(assessRisk(descriptor('filesystem.delete_everything', 'READ')).level).toBe('NONE')
    expect(assessRisk(descriptor('harmless.name', 'WRITE')).level).toBe('PERMISSION_REQUIRED')
  })
})

describe('assessRisk：与 registry 对账', () => {
  it('registry 里每个 READ 都是 NONE，每个 WRITE 都是 PERMISSION_REQUIRED', () => {
    // 全覆盖而不是挑两个：TASK-020 会新增 WRITE 执行体，
    // 这条会在有人往 registry 加了能力却忘了风险模型跟着走时立刻红。
    for (const c of listCapabilities()) {
      const expected = c.kind === 'WRITE' ? 'PERMISSION_REQUIRED' : 'NONE'
      expect(assessRisk(c).level, c.name).toBe(expected)
    }
  })

  it('Phase 2 的现状：两个 READ、四个 WRITE', () => {
    // 钉数量是为了让「有人悄悄把一个 WRITE 改成 READ」这件事变红。
    // 改成 READ 就绕过了 Permission，而 Phase 2 的整个 Exit Gate 建立在它之上。
    expect(listByKind('READ').map((c) => c.name)).toEqual([
      'filesystem.list',
      'document.extract_pdf'
    ])
    expect(listByKind('WRITE').map((c) => c.name)).toEqual([
      'filesystem.create_dir',
      'filesystem.move',
      'scheduler.create',
      'notification.send'
    ])
  })
})
