import { describe, expect, it } from 'vitest'
import { PreflightManager } from './preflight'

describe('PreflightManager (危险操作预检-确认两段式)', () => {
  it('创建预检发票，生成有效 ticketId 与幂等键', () => {
    const manager = new PreflightManager()
    const ticket = manager.createTicket(
      'task-1',
      'filesystem_move',
      { source: 'a.pdf', target: 'b.pdf' },
      {
        estimatedFilesAffected: 1,
        isIrreversible: true,
        description: '移动关键交付文件'
      }
    )

    expect(ticket.ticketId.startsWith('tkt_')).toBe(true)
    expect(ticket.idempotencyKey.length).toBe(64)
    expect(ticket.impact.estimatedFilesAffected).toBe(1)
  })

  it('发票单次核销：消费一次后失效，防止重放攻击', () => {
    const manager = new PreflightManager()
    const ticket = manager.createTicket(
      'task-1',
      'terminal_execute',
      { command: 'npm run build' },
      {
        estimatedFilesAffected: 10,
        isIrreversible: false,
        description: '构建工程产物'
      }
    )

    const firstConsume = manager.consumeTicket(ticket.ticketId)
    expect(firstConsume.valid).toBe(true)
    expect(firstConsume.ticket?.ticketId).toBe(ticket.ticketId)

    const secondConsume = manager.consumeTicket(ticket.ticketId)
    expect(secondConsume.valid).toBe(false)
    expect(secondConsume.reason).toContain('票据不存在或已被核销')
  })

  it('过期发票拒绝核销', () => {
    const manager = new PreflightManager()
    const ticket = manager.createTicket(
      'task-1',
      'terminal_execute',
      { command: 'echo hello' },
      {
        estimatedFilesAffected: 0,
        isIrreversible: false,
        description: '只读命令'
      },
      -1000 // 已经过期
    )

    const consume = manager.consumeTicket(ticket.ticketId)
    expect(consume.valid).toBe(false)
    expect(consume.reason).toContain('票据已过期')
  })
})
