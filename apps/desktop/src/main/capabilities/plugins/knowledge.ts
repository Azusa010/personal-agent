import { ERROR_CODE, KnowledgeSearchParams, UserMemorySearchParams } from '@personal-agent/protocol'

import type { CapabilityPlugin } from '../plugin'
import {
  describeError,
  fail,
  invalid,
  wrapExternalSource,
  KNOWLEDGE_ISOLATION_HEADER,
  KNOWLEDGE_ISOLATION_FOOTER,
  USER_MEMORY_ISOLATION_HEADER,
  USER_MEMORY_ISOLATION_FOOTER
} from './helpers'

export const knowledgeSearchPlugin: CapabilityPlugin = {
  name: 'knowledge_search',
  descriptor: {
    name: 'knowledge_search',
    kind: 'READ',
    description: '在知识库中进行混合语义与关键词全文检索'
  },
  async bindArguments(args) {
    const parsed = KnowledgeSearchParams.safeParse(args)
    if (!parsed.success) return invalid('knowledge_search', parsed.error.message)
    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: {}
      }
    }
  },
  async execute(call, context) {
    const knowledge = context.knowledge
    if (knowledge === undefined) {
      return fail(ERROR_CODE.NOT_IMPLEMENTED, 'knowledge_search 没有接线知识库检索端口')
    }
    try {
      const rawResult = await knowledge.search(call.bound.args)
      if (typeof rawResult !== 'object' || rawResult === null) {
        return fail(ERROR_CODE.HOST_HANDLER_FAILED, '知识库检索返回无效响应')
      }
      if (rawResult['ok'] === false) {
        return fail(
          String(rawResult['code'] ?? ERROR_CODE.HOST_HANDLER_FAILED),
          String(rawResult['reason'] ?? '知识库检索失败')
        )
      }
      const chunks = Array.isArray(rawResult['chunks']) ? rawResult['chunks'] : []
      const wrappedChunks = chunks.map((item) => {
        if (typeof item === 'object' && item !== null && 'rawText' in item) {
          return {
            ...item,
            rawText: wrapExternalSource(
              String(item.rawText ?? ''),
              KNOWLEDGE_ISOLATION_HEADER,
              KNOWLEDGE_ISOLATION_FOOTER
            )
          }
        }
        return item
      })
      return {
        ...rawResult,
        ok: true,
        chunks: wrappedChunks
      }
    } catch (e) {
      return fail(ERROR_CODE.HOST_HANDLER_FAILED, `知识库检索执行失败: ${describeError(e)}`)
    }
  }
}

export const userMemorySearchPlugin: CapabilityPlugin = {
  name: 'user_memory_search',
  descriptor: {
    name: 'user_memory_search',
    kind: 'READ',
    description: '在用户记忆库中进行语义与全文检索（支持时间切片与实体消歧）'
  },
  async bindArguments(args) {
    const parsed = UserMemorySearchParams.safeParse(args)
    if (!parsed.success) return invalid('user_memory_search', parsed.error.message)
    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: {}
      }
    }
  },
  async execute(call, context) {
    const memory = context.memory
    if (memory === undefined) {
      return fail(ERROR_CODE.NOT_IMPLEMENTED, 'user_memory_search 没有接线用户记忆检索端口')
    }
    try {
      const rawResult = await memory.search(call.bound.args)
      if (typeof rawResult !== 'object' || rawResult === null) {
        return fail(ERROR_CODE.HOST_HANDLER_FAILED, '用户记忆检索返回无效响应')
      }
      if (rawResult['ok'] === false) {
        return fail(
          String(rawResult['code'] ?? ERROR_CODE.HOST_HANDLER_FAILED),
          String(rawResult['reason'] ?? '用户记忆检索失败')
        )
      }
      const items = Array.isArray(rawResult['items']) ? rawResult['items'] : []
      const wrappedItems = items.map((item) => {
        if (typeof item === 'object' && item !== null && 'matchedText' in item) {
          return {
            ...item,
            matchedText: wrapExternalSource(
              String(item.matchedText ?? ''),
              USER_MEMORY_ISOLATION_HEADER,
              USER_MEMORY_ISOLATION_FOOTER
            )
          }
        }
        return item
      })
      return {
        ...rawResult,
        ok: true,
        items: wrappedItems
      }
    } catch (e) {
      return fail(ERROR_CODE.HOST_HANDLER_FAILED, `用户记忆检索执行失败: ${describeError(e)}`)
    }
  }
}
