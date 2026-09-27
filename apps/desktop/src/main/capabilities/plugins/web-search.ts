import { WebSearchParams } from '@personal-agent/protocol'
import type { CapabilityPlugin } from '../plugin'
import { searchTavily, WebSearchError } from '../web-search'
import { fail, invalid } from './helpers'

export const webSearchPlugin: CapabilityPlugin = {
  name: 'web_search',
  descriptor: {
    name: 'web_search',
    kind: 'READ',
    description: '使用 Tavily 搜索引擎在互联网上实时检索最新网页资讯与事实答案'
  },
  async bindArguments(args) {
    const parsed = WebSearchParams.safeParse(args)
    if (!parsed.success) return invalid('web_search', parsed.error.message)

    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: {}
      }
    }
  },
  async execute(call) {
    try {
      const result = await searchTavily(call.bound.args as unknown as WebSearchParams)
      return result
    } catch (e) {
      if (e instanceof WebSearchError) {
        return fail(e.code, e.message)
      }
      return fail('WEB_SEARCH_FAILED', e instanceof Error ? e.message : String(e))
    }
  }
}
