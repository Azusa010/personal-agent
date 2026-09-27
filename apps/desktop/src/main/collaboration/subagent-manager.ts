/**
 * Subagent 实例管理与消息收发协调器
 *
 * 依据第 4 章：协作原语支持 spawn_subagent, send_subagent_message, cancel_subagent, list_subagents
 */

import {
  wrapMainToSubagentMessage,
  unwrapSubagentToMainMessage,
  wrapSubagentToMainMessage,
  type UnwrappedMessage
} from './isolation'

export type SubagentStatus = 'created' | 'running' | 'completed' | 'cancelled' | 'failed'

export interface SubagentRecord {
  readonly id: string
  readonly parentTaskId: string
  readonly name: string
  readonly role: string
  readonly prompt: string
  readonly wrappedPrompt: string
  status: SubagentStatus
  readonly createdAt: number
  updatedAt: number
  result?: string
  error?: string
}

export interface SpawnSubagentParams {
  readonly parentTaskId: string
  readonly name: string
  readonly role: string
  readonly prompt: string
}

export interface SendMessageResult {
  readonly subagentId: string
  readonly wrappedMessage: string
  readonly timestamp: number
}

export class SubagentManager {
  private readonly subagents = new Map<string, SubagentRecord>()
  private counter = 0

  /**
   * 孵化一个带有安全标头隔离的子 Agent
   */
  spawn(params: SpawnSubagentParams): SubagentRecord {
    this.counter += 1
    const id = `subagent-${Date.now()}-${this.counter}`
    const now = Date.now()

    const wrappedPrompt = wrapMainToSubagentMessage(params.prompt, {
      parentTaskId: params.parentTaskId,
      subagentId: id,
      role: params.role,
      timestamp: now
    })

    const record: SubagentRecord = {
      id,
      parentTaskId: params.parentTaskId,
      name: params.name,
      role: params.role,
      prompt: params.prompt,
      wrappedPrompt,
      status: 'created',
      createdAt: now,
      updatedAt: now
    }

    this.subagents.set(id, record)
    return record
  }

  /**
   * 向子 Agent 发送通信消息（经防注入标头封装）
   */
  sendMessage(subagentId: string, message: string): SendMessageResult {
    const subagent = this.subagents.get(subagentId)
    if (!subagent) {
      throw new Error(`Subagent not found: ${subagentId}`)
    }
    if (
      subagent.status === 'cancelled' ||
      subagent.status === 'completed' ||
      subagent.status === 'failed'
    ) {
      throw new Error(`Cannot send message to subagent in terminal status: ${subagent.status}`)
    }

    subagent.status = 'running'
    subagent.updatedAt = Date.now()

    const wrappedMessage = wrapMainToSubagentMessage(message, {
      parentTaskId: subagent.parentTaskId,
      subagentId,
      timestamp: subagent.updatedAt
    })

    return {
      subagentId,
      wrappedMessage,
      timestamp: subagent.updatedAt
    }
  }

  /**
   * 接收并解包子 Agent 返回的消息
   */
  receiveMessage(subagentId: string, rawResponse: string): UnwrappedMessage {
    const subagent = this.subagents.get(subagentId)
    if (!subagent) {
      throw new Error(`Subagent not found: ${subagentId}`)
    }

    subagent.updatedAt = Date.now()
    return unwrapSubagentToMainMessage(rawResponse)
  }

  /**
   * 模拟子 Agent 回复主 Agent
   */
  formatSubagentReply(subagentId: string, replyContent: string): string {
    const subagent = this.subagents.get(subagentId)
    return wrapSubagentToMainMessage(replyContent, {
      subagentId,
      parentTaskId: subagent?.parentTaskId,
      timestamp: Date.now()
    })
  }

  /**
   * 完成子 Agent 任务
   */
  complete(subagentId: string, result: string): SubagentRecord {
    const subagent = this.subagents.get(subagentId)
    if (!subagent) {
      throw new Error(`Subagent not found: ${subagentId}`)
    }

    subagent.status = 'completed'
    subagent.result = result
    subagent.updatedAt = Date.now()
    return subagent
  }

  /**
   * 标记子 Agent 失败
   */
  fail(subagentId: string, error: string): SubagentRecord {
    const subagent = this.subagents.get(subagentId)
    if (!subagent) {
      throw new Error(`Subagent not found: ${subagentId}`)
    }

    subagent.status = 'failed'
    subagent.error = error
    subagent.updatedAt = Date.now()
    return subagent
  }

  /**
   * 取消子 Agent
   */
  cancel(subagentId: string, reason = 'Cancelled by user or supervisor'): boolean {
    const subagent = this.subagents.get(subagentId)
    if (!subagent) {
      return false
    }
    if (subagent.status === 'completed' || subagent.status === 'cancelled') {
      return false
    }

    subagent.status = 'cancelled'
    subagent.error = reason
    subagent.updatedAt = Date.now()
    return true
  }

  /**
   * 获取指定子 Agent
   */
  get(subagentId: string): SubagentRecord | undefined {
    return this.subagents.get(subagentId)
  }

  /**
   * 列出子 Agent（可按 parentTaskId 过滤）
   */
  list(parentTaskId?: string): readonly SubagentRecord[] {
    const all = Array.from(this.subagents.values())
    if (!parentTaskId) {
      return all
    }
    return all.filter((s) => s.parentTaskId === parentTaskId)
  }

  /**
   * 清除所有记录（用于测试重置）
   */
  clear(): void {
    this.subagents.clear()
    this.counter = 0
  }
}
