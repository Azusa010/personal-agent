import { describe, it, expect } from 'vitest'
import {
  CAPABILITIES,
  listCapabilities,
  listByKind,
  findCapability,
  type CapabilityName
} from './registry'
import { readOnlyScope, isInScope } from './scope'
import { CapabilityId } from '@personal-agent/protocol'

/**
 * 完整正面清单：REQ-006 的六个能力 + Phase 3 的 terminal_execute。
 * SEC-007 的禁止项（Shell、代码执行、删除、覆盖、任意网络）
 * 自动被排除，不需要另写负面清单。
 */
const ALL_CAPABILITY_NAMES = [
  'filesystem_list',
  'document_extract_pdf',
  'filesystem_create_dir',
  'filesystem_move',
  'scheduler_create',
  'notification_send',
  'terminal_execute',
  'knowledge_search',
  'user_memory_search'
]

describe('CapabilityRegistry', () => {
  it('恰好注册 9 个能力，不多不少', () => {
    const names = listCapabilities().map((c) => c.name)
    expect([...names].sort()).toEqual([...ALL_CAPABILITY_NAMES].sort())
    expect(CAPABILITIES).toHaveLength(9)

    // SEC-007 的禁止类名字必须查不到
    for (const forbidden of ['shell.exec', 'process.spawn', 'filesystem.delete', 'http.fetch']) {
      expect(findCapability(forbidden), `${forbidden} 不应被注册`).toBeNull()
    }
  })

  it('分类为 4 READ + 5 WRITE', () => {
    expect(listByKind('READ').map((c) => c.name)).toEqual([
      'filesystem_list',
      'document_extract_pdf',
      'knowledge_search',
      'user_memory_search'
    ])
    expect(listByKind('WRITE').map((c) => c.name)).toEqual([
      'filesystem_create_dir',
      'filesystem_move',
      'scheduler_create',
      'notification_send',
      'terminal_execute'
    ])
    // 两类不重不漏
    expect(listByKind('READ').length + listByKind('WRITE').length).toBe(CAPABILITIES.length)
  })

  it('readOnlyScope 恰好含 4 个 READ，不含任何 WRITE', () => {
    const scope = readOnlyScope('t-1')
    expect(scope.taskId).toBe('t-1')
    expect([...scope.capabilities].sort()).toEqual([
      'document_extract_pdf',
      'filesystem_list',
      'knowledge_search',
      'user_memory_search'
    ])

    // Phase 1 Exit 第 3 条：Agent 只能看到 Scope 中两个 READ Capability
    for (const write of listByKind('WRITE')) {
      expect(isInScope(scope, write.name), `${write.name} 不应在 Phase 1 Scope 内`).toBe(false)
    }

    // Scope 里每个名字都必须真在 Registry 中注册（防漂移）
    for (const name of scope.capabilities) {
      expect(findCapability(name)).not.toBeNull()
    }
  })

  it('边界：未注册返回 null，Scope 外返回 false', () => {
    const scope = readOnlyScope('t-1')

    expect(findCapability('filesystem_list')?.kind).toBe('READ')
    expect(findCapability('filesystem.rename')).toBeNull() // 近似名也不行
    expect(findCapability('')).toBeNull()
    expect(findCapability('FILESYSTEM.LIST')).toBeNull() // 大小写敏感，不做宽松匹配

    expect(isInScope(scope, 'filesystem_list')).toBe(true)
    expect(isInScope(scope, 'filesystem_move')).toBe(false) // 注册了但不在 Scope
    expect(isInScope(scope, '没注册过')).toBe(false)
    expect(isInScope(readOnlyScope('t-2'), 'filesystem_list')).toBe(true) // 与 taskId 无关
  })
})

describe('类型层面的保证', () => {
  it('Scope 收不进未注册的名字', () => {
    // @ts-expect-error CapabilityName 只含 REQ-006 那六个；
    // 若哪天它被放宽成 string，本行不再报错，@ts-expect-error 指令自身会红（双向钉住）。
    const bad: CapabilityName = 'filesystem.delete'
    expect(bad).toBe('filesystem.delete')
  })
})

describe('契约层与 registry 的能力清单一致', () => {
  /**
   * host.ts 的 CapabilityId 和 registry.ts 的 CAPABILITIES 是两处真相：
   * 前者要给 Python 侧做 wire 校验，后者是 TS 侧运行时清单。
   * 不强行合并成单一来源（那会让 registry 反向依赖 protocol 的构建产物），
   * 用这条钉住不漂移。
   */
  it('CapabilityId enum 与 CAPABILITIES 名字集合相同', () => {
    const fromContract = [...CapabilityId.options].sort()
    expect(fromContract).toEqual([...ALL_CAPABILITY_NAMES].sort())
    expect(fromContract).toEqual(
      listCapabilities()
        .map((c) => c.name)
        .sort()
    )
  })
})
