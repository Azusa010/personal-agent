import { describe, it, expect } from 'vitest'
import { RuleBasedToolRetriever } from './retriever'
import { readOnlyScope } from './scope'
import { CAPABILITIES, listByKind } from './registry'

const retriever = new RuleBasedToolRetriever()

describe('RuleBasedToolRetriever', () => {
  it('不可见门：Phase 1 Scope 下只暴露两个 READ Capability', () => {
    const visible = retriever.listVisible(readOnlyScope('t-1'))

    // Phase 1 Exit Checklist 第 3 条
    expect(visible.map((c) => c.name)).toEqual(['filesystem.list', 'document.extract_pdf'])
    expect(visible.every((c) => c.kind === 'READ')).toBe(true)
    // 四个 WRITE 一个都看不见
    expect(visible).toHaveLength(listByKind('READ').length)
  })

  it('可见列表带 description，Agent 才能据此选工具', () => {
    const visible = retriever.listVisible(readOnlyScope('t-1'))
    for (const c of visible) {
      expect(c.description.length).toBeGreaterThan(0)
      expect(c.kind).toBeDefined()
    }
  })

  it('可执行门：Scope 内 READ 放行，并直接带回 descriptor', () => {
    const result = retriever.authorize(readOnlyScope('t-1'), 'filesystem.list')

    expect(result.allowed).toBe(true)
    if (result.allowed) {
      // 判别联合：只有分支之后才访问得到 capability
      expect(result.capability.name).toBe('filesystem.list')
      expect(result.capability.kind).toBe('READ')
    }
  })

  it('两种拒绝码不可混淆：未注册 vs Scope 外', () => {
    const scope = readOnlyScope('t-1')

    const unregistered = retriever.authorize(scope, 'filesystem.rename')
    expect(unregistered.allowed).toBe(false)
    if (!unregistered.allowed) {
      expect(unregistered.code).toBe('CAPABILITY_NOT_REGISTERED')
      expect(unregistered.name).toBe('filesystem.rename') // 回带原名字便于记 ExecutionEvent
    }

    // 注册了但不在 Phase 1 Scope
    const outOfScope = retriever.authorize(scope, 'filesystem.move')
    expect(outOfScope.allowed).toBe(false)
    if (!outOfScope.allowed) {
      expect(outOfScope.code).toBe('CAPABILITY_OUT_OF_SCOPE')
      expect(outOfScope.reason).toContain('t-1')
    }
  })

  it('TEST-005：未注册与 Scope 外的 ToolCall 100% 拒绝', () => {
    const scope = readOnlyScope('t-1')

    // SEC-007 的禁止类 + 幻觉名 + 边界输入，一个都不能放行
    const hostile = [
      'shell.exec',
      'process.spawn',
      'filesystem.delete',
      'filesystem.remove',
      'filesystem.overwrite',
      'http.fetch',
      'network.request',
      'eval',
      '',
      'FILESYSTEM.LIST', // 大小写不宽松匹配
      ' filesystem.list', // 前导空格
      'filesystem.list ', // 尾随空格
      '__proto__',
      'constructor'
    ]
    for (const name of hostile) {
      expect(retriever.authorize(scope, name).allowed, `${name} 不应被放行`).toBe(false)
    }

    // 四个 WRITE 全部拒绝
    for (const write of listByKind('WRITE')) {
      expect(retriever.authorize(scope, write.name).allowed, `${write.name} 不应被放行`).toBe(false)
    }

    // 放行的必须恰好是 Scope 里那两个，不多不少
    const allowed = CAPABILITIES.filter((c) => retriever.authorize(scope, c.name).allowed)
    expect(allowed.map((c) => c.name)).toEqual(['filesystem.list', 'document.extract_pdf'])
  })

  it('Scope 无法被运行时扩权：push 在编译期即被拒', () => {
    const scope = readOnlyScope('t-1')

    // @ts-expect-error capabilities 为 readonly，没有 push；
    // 若哪天 readonly 被去掉，本行不再报错，指令自身会红（双向钉住）。
    const pushFn: unknown = scope.capabilities.push
    // readonly 只是编译期的：运行时拿到的是真数组，push 确实存在。
    // 只取不调用 —— 调了就真的扩权了，测试意图反过来。
    expect(typeof pushFn).toBe('function')

    expect(scope.capabilities).toHaveLength(2)
    expect(retriever.authorize(scope, 'filesystem.move').allowed).toBe(false)
  })
})
