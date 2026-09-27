import * as z from 'zod'
import { CapabilityFailure } from './host'

export const WebSearchDepth = z.enum(['basic', 'advanced'])
export type WebSearchDepth = z.infer<typeof WebSearchDepth>

export const WebSearchParams = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(20).optional().default(5),
  searchDepth: WebSearchDepth.optional().default('basic'),
  includeAnswer: z.boolean().optional().default(false)
})
export type WebSearchParams = z.infer<typeof WebSearchParams>
export type WebSearchParamsInput = z.input<typeof WebSearchParams>

export const WebSearchResultItem = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number().optional(),
  publishedDate: z.string().optional()
})
export type WebSearchResultItem = z.infer<typeof WebSearchResultItem>

export const WebSearchResult = z.object({
  ok: z.literal(true),
  query: z.string(),
  results: z.array(WebSearchResultItem),
  answer: z.string().optional()
})
export type WebSearchResult = z.infer<typeof WebSearchResult>

export const WebSearchOutcome = z.discriminatedUnion('ok', [WebSearchResult, CapabilityFailure])
export type WebSearchOutcome = z.infer<typeof WebSearchOutcome>
