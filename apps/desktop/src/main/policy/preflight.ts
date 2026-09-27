import { createHash, randomUUID } from 'node:crypto'

export interface PreflightImpact {
  readonly estimatedFilesAffected: number
  readonly isIrreversible: boolean
  readonly description: string
}

export interface PreflightTicket {
  readonly ticketId: string
  readonly taskId: string
  readonly capability: string
  readonly idempotencyKey: string
  readonly expiresAt: number
  readonly impact: PreflightImpact
}

/**
 * 危险操作预检发票（Preflight Ticket）存储与生命周期管理（第 4 章：预检-确认两段式）。
 * 在高影响面操作前评估影响面并颁发一次性、防篡改票据，确认阶段严格校验票据有效性与幂等性。
 */
export class PreflightManager {
  private readonly tickets = new Map<string, PreflightTicket>()

  createTicket(
    taskId: string,
    capability: string,
    args: Record<string, unknown>,
    impact: PreflightImpact,
    ttlMs: number = 5 * 60 * 1000
  ): PreflightTicket {
    const rawPayload = `${taskId}:${capability}:${JSON.stringify(args)}`
    const idempotencyKey = createHash('sha256').update(rawPayload).digest('hex')
    const ticketId = `tkt_${randomUUID().slice(0, 12)}`
    const expiresAt = Date.now() + ttlMs

    const ticket: PreflightTicket = {
      ticketId,
      taskId,
      capability,
      idempotencyKey,
      expiresAt,
      impact
    }

    this.tickets.set(ticketId, ticket)
    return ticket
  }

  consumeTicket(ticketId: string): {
    valid: boolean
    ticket?: PreflightTicket
    reason?: string
  } {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) {
      return { valid: false, reason: '票据不存在或已被核销' }
    }

    if (Date.now() > ticket.expiresAt) {
      this.tickets.delete(ticketId)
      return { valid: false, reason: '票据已过期，请重新发起预检' }
    }

    // 票据单次消费核销，防止重放
    this.tickets.delete(ticketId)
    return { valid: true, ticket }
  }
}
