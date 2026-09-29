import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ERROR_CODE } from '@personal-agent/protocol'
import { searchTavily, WebSearchError } from '../../../src/main/capabilities/web-search'
import { webSearchPlugin } from '../../../src/main/capabilities/plugins/web-search'

describe('web_search (Tavily Search Tool)', () => {
  const originalApiKey = process.env.TAVILY_API_KEY

  beforeEach(() => {
    delete process.env.TAVILY_API_KEY
  })

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.TAVILY_API_KEY = originalApiKey
    } else {
      delete process.env.TAVILY_API_KEY
    }
    vi.restoreAllMocks()
  })

  it('缺失 API Key 时抛出稳定错误码 WEB_SEARCH_API_KEY_MISSING', async () => {
    let error: unknown
    try {
      await searchTavily({ query: 'PersonalAgent' }, { apiKey: '   ' })
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(WebSearchError)
    expect((error as WebSearchError).code).toBe(ERROR_CODE.WEB_SEARCH_API_KEY_MISSING)
  })

  it('成功通过 Tavily API 检索并将响应映射为 WebSearchResult 标准格式', async () => {
    const mockTavilyResponse = {
      query: 'AI Agent Architecture',
      answer:
        'AI Agents are autonomous systems equipped with perception, execution, and planning tools.',
      results: [
        {
          title: 'Deep Understanding of AI Agents',
          url: 'https://example.com/ai-agents',
          content: 'Chapter 4 details Agent-Computer Interfaces and tool designs.',
          score: 0.98,
          published_date: '2026-09-01'
        },
        {
          title: 'Tavily Search API',
          url: 'https://tavily.com',
          content: 'Search API built for AI agents and LLMs.',
          score: 0.89
        }
      ]
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTavilyResponse
    })

    const out = await searchTavily(
      { query: 'AI Agent Architecture', maxResults: 5, includeAnswer: true },
      { apiKey: 'tvly-test-mock-key', fetchFn: mockFetch as unknown as typeof fetch }
    )

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(out.ok).toBe(true)
    expect(out.query).toBe('AI Agent Architecture')
    expect(out.results).toHaveLength(2)
    expect(out.results[0].publishedDate).toBe('2026-09-01')
    expect(out.answer).toBe(mockTavilyResponse.answer)
  })

  it('Tavily API 返回非 200 状态码时抛出 WEB_SEARCH_FAILED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    })

    let error: unknown
    try {
      await searchTavily(
        { query: 'Invalid Key Test' },
        { apiKey: 'bad-key', fetchFn: mockFetch as unknown as typeof fetch }
      )
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(WebSearchError)
    expect((error as WebSearchError).code).toBe(ERROR_CODE.WEB_SEARCH_FAILED)
  })

  it('webSearchPlugin 插件元数据契约完整且属于只读能力', () => {
    expect(webSearchPlugin.name).toBe('web_search')
    expect(webSearchPlugin.descriptor.kind).toBe('READ')
    expect(webSearchPlugin.descriptor.description).toContain('Tavily')
  })
})
