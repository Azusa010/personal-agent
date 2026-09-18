import { describe, expect, it, vi } from 'vitest'

import type { AgentStreamNotice } from '../../shared/ipc-contract'
import { onAgentStream, publishAgentStream } from './stream-fanout'

function aNotice(delta = '先列目录'): AgentStreamNotice {
  return { kind: 'thinking', taskId: 't-1', delta }
}

/**
 * 实时通知的进程内总线（TASK-033 R2）。
 *
 * 它自己不做解析——形状已经在 supervisor 那层用 AgentStreamNotification 钉过；
 * 这里只管「谁能收到、退订之后还收不收、一个订阅者坏了会不会连累别人」。
 */
describe('stream-fanout', () => {
  it('订阅之后能收到派发出去的通知', () => {
    const seen: AgentStreamNotice[] = []
    const off = onAgentStream((notice) => seen.push(notice))
    try {
      publishAgentStream(aNotice())
      expect(seen).toEqual([aNotice()])
    } finally {
      off()
    }
  })

  it('多个订阅者各收到一份同一条通知', () => {
    const first: AgentStreamNotice[] = []
    const second: AgentStreamNotice[] = []
    const offFirst = onAgentStream((notice) => first.push(notice))
    const offSecond = onAgentStream((notice) => second.push(notice))
    try {
      publishAgentStream(aNotice('a'))
      publishAgentStream(aNotice('b'))
      expect(first.map((n) => n.kind === 'thinking' && n.delta)).toEqual(['a', 'b'])
      expect(second.map((n) => n.kind === 'thinking' && n.delta)).toEqual(['a', 'b'])
    } finally {
      offFirst()
      offSecond()
    }
  })

  it('退订之后不再收到；重复退订不抛', () => {
    const seen: AgentStreamNotice[] = []
    const off = onAgentStream((notice) => seen.push(notice))
    off()
    off() // 幂等：窗口销毁路径可能重入
    publishAgentStream(aNotice())
    expect(seen).toEqual([])
  })

  it('退订一个不影响另一个', () => {
    const kept: AgentStreamNotice[] = []
    const dropped: AgentStreamNotice[] = []
    const offKept = onAgentStream((notice) => kept.push(notice))
    const offDropped = onAgentStream((notice) => dropped.push(notice))
    try {
      offDropped()
      publishAgentStream(aNotice())
      expect(kept).toHaveLength(1)
      expect(dropped).toEqual([])
    } finally {
      offKept()
    }
  })

  it('一个订阅者抛异常不连累其他订阅者，且留下日志', () => {
    // 一个窗口的渲染错误不该让别的窗口收不到通知。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const healthy: AgentStreamNotice[] = []
    const offBad = onAgentStream(() => {
      throw new Error('订阅者坏了')
    })
    const offGood = onAgentStream((notice) => healthy.push(notice))
    try {
      expect(() => publishAgentStream(aNotice())).not.toThrow()
      expect(healthy).toHaveLength(1)
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      offBad()
      offGood()
      spy.mockRestore()
    }
  })
})
