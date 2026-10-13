import {
  ERROR_CODE,
  WebSearchParams,
  type WebSearchParamsInput,
  type WebSearchResult,
  type WebSearchResultItem
} from '@personal-agent/protocol'

import { defineBinder } from '../binder'
import type { CapabilityPlugin } from '../plugin'
import { fail } from './helpers'

export const DEFAULT_TAVILY_ENDPOINT = 'https://api.tavily.com/search'

export class WebSearchError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WebSearchError'
  }
}

export interface TavilySearchOptions {
  readonly apiKey?: string
  readonly fetchFn?: typeof fetch
  readonly endpoint?: string
  readonly timeoutMs?: number
}

interface TavilyRawResultItem {
  title?: string
  url?: string
  content?: string
  score?: number
  published_date?: string
}

interface TavilyRawResponse {
  query?: string
  answer?: string
  results?: TavilyRawResultItem[]
}

/**
 * 调用 Tavily 官方 REST API 检索网络内容
 */
export async function searchTavily(
  params: WebSearchParamsInput,
  options: TavilySearchOptions = {}
): Promise<WebSearchResult> {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const endpoint = options.endpoint ?? process.env.TAVILY_ENDPOINT ?? DEFAULT_TAVILY_ENDPOINT
  const apiKey = options.apiKey?.trim() ?? process.env.TAVILY_API_KEY?.trim()

  if (!apiKey) {
    throw new WebSearchError(
      ERROR_CODE.WEB_SEARCH_API_KEY_MISSING,
      '未配置 TAVILY_API_KEY 环境变量，请在设置或环境变量中配置'
    )
  }

  let rawData: TavilyRawResponse = {}
  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: params.query,
        max_results: params.maxResults ?? 5,
        search_depth: params.searchDepth ?? 'basic',
        include_answer: params.includeAnswer ?? false
      }),
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined
    })
    if (!response.ok) {
      throw new WebSearchError(
        ERROR_CODE.WEB_SEARCH_FAILED,
        `Tavily API 返回异常状态码: ${response.status}`
      )
    }
    rawData = (await response.json()) as TavilyRawResponse
  } catch (e) {
    if (e instanceof WebSearchError) throw e
    throw new WebSearchError(
      ERROR_CODE.WEB_SEARCH_FAILED,
      `Tavily 网络请求失败: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  const results: WebSearchResultItem[] = (rawData.results ?? []).map((item) => ({
    title: item.title ?? '',
    url: item.url ?? '',
    content: item.content ?? '',
    score: item.score ?? 0,
    publishedDate: item.published_date
  }))

  return {
    ok: true,
    query: params.query,
    results,
    answer: rawData.answer
  }
}

export const webSearchPlugin: CapabilityPlugin = {
  name: 'web_search',
  descriptor: {
    name: 'web_search',
    kind: 'READ',
    description: '使用 Tavily 搜索引擎在互联网上实时检索最新网页资讯与事实答案'
  },
  bindArguments: defineBinder('web_search', WebSearchParams),
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
