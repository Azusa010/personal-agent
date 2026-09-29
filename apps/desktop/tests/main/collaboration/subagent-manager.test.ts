import { describe, expect, it, beforeEach } from 'vitest'
import { SubagentManager } from '../../../src/main/collaboration/subagent-manager'

describe('SubagentManager 原语测试', () => {
  let manager: SubagentManager

  beforeEach(() => {
    manager = new SubagentManager()
  })

  it('spawn 创建隔离子 Agent，状态为 created', () => {
    const subagent = manager.spawn({
      parentTaskId: 'task-root',
      name: 'worker-1',
      role: 'Code Auditor',
      prompt: '审查代码安全性'
    })

    expect(subagent.id).toMatch(/^subagent-\d+-1$/)
    expect(subagent.parentTaskId).toBe('task-root')
    expect(subagent.name).toBe('worker-1')
    expect(subagent.status).toBe('created')
    expect(subagent.wrappedPrompt).toContain('[FROM_MAIN_AGENT_START]')
    expect(subagent.wrappedPrompt).toContain('Code Auditor')
  })

  it('sendMessage 更新状态为 running 并返回包装后的消息', () => {
    const subagent = manager.spawn({
      parentTaskId: 'task-root',
      name: 'worker-1',
      role: 'Worker',
      prompt: '初始提示'
    })

    const result = manager.sendMessage(subagent.id, '请继续执行第 2 步')
    expect(result.subagentId).toBe(subagent.id)
    expect(result.wrappedMessage).toContain('[FROM_MAIN_AGENT_START]')
    expect(result.wrappedMessage).toContain('请继续执行第 2 步')

    const updated = manager.get(subagent.id)
    expect(updated?.status).toBe('running')
  })

  it('receiveMessage 成功解包子 Agent 回复', () => {
    const subagent = manager.spawn({
      parentTaskId: 'task-root',
      name: 'worker-1',
      role: 'Worker',
      prompt: '初始提示'
    })

    const rawReply = manager.formatSubagentReply(subagent.id, '步骤 2 已成功完成')
    const received = manager.receiveMessage(subagent.id, rawReply)

    expect(received.isValid).toBe(true)
    expect(received.content).toBe('步骤 2 已成功完成')
  })

  it('生命周期推进：complete 与 fail', () => {
    const s1 = manager.spawn({
      parentTaskId: 'task-root',
      name: 'worker-success',
      role: 'Worker',
      prompt: 'foo'
    })
    manager.complete(s1.id, '交付物已生成')
    expect(manager.get(s1.id)?.status).toBe('completed')
    expect(manager.get(s1.id)?.result).toBe('交付物已生成')

    const s2 = manager.spawn({
      parentTaskId: 'task-root',
      name: 'worker-fail',
      role: 'Worker',
      prompt: 'bar'
    })
    manager.fail(s2.id, '沙盒超时')
    expect(manager.get(s2.id)?.status).toBe('failed')
    expect(manager.get(s2.id)?.error).toBe('沙盒超时')
  })

  it('cancel 可以取消未完成的子 Agent', () => {
    const s = manager.spawn({
      parentTaskId: 'task-root',
      name: 'worker-cancel',
      role: 'Worker',
      prompt: 'baz'
    })

    const cancelled = manager.cancel(s.id, '用户中止')
    expect(cancelled).toBe(true)
    expect(manager.get(s.id)?.status).toBe('cancelled')

    // 已终止的 Agent 再次 cancel 返回 false
    expect(manager.cancel(s.id)).toBe(false)

    // 向已取消的 Agent 发送消息抛出异常
    expect(() => manager.sendMessage(s.id, 'hi')).toThrow(
      /Cannot send message to subagent in terminal status/
    )
  })

  it('list 支持按 parentTaskId 过滤', () => {
    manager.spawn({ parentTaskId: 'task-A', name: 'a1', role: 'r', prompt: 'p' })
    manager.spawn({ parentTaskId: 'task-A', name: 'a2', role: 'r', prompt: 'p' })
    manager.spawn({ parentTaskId: 'task-B', name: 'b1', role: 'r', prompt: 'p' })

    expect(manager.list()).toHaveLength(3)
    expect(manager.list('task-A')).toHaveLength(2)
    expect(manager.list('task-B')).toHaveLength(1)
    expect(manager.list('task-C')).toHaveLength(0)
  })
})
