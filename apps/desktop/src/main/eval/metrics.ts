import type { CaseVerdict } from './judge'
import type { EvalCaseType } from './case-manifest'
import type { ModelUsagePayload } from './observation'

/**
 * 报告里的统计口径（TASK-027 Validation：成功率、页码、工具、成本、延迟）。
 *
 * 纯函数：输入是逐条 case 的判定与观察，输出是数字。所有比值在分母为 0 时报 0
 * 而不是 NaN —— 报告是要被人读、被 diff 的，NaN 会在 JSON 里变成 null 之外
 * 的第三种"没有值"，读的人分不清是没跑还是算错。
 */

/** 单价。USD / 百万 token。不内置价目表：模型价格会变，猜一个数写死比留空更坏 */
export interface EvalPricing {
  inputPerMTok: number
  outputPerMTok: number
}

export const PRICE_INPUT_ENV = 'EVAL_PRICE_INPUT_PER_MTOK'
export const PRICE_OUTPUT_ENV = 'EVAL_PRICE_OUTPUT_PER_MTOK'

/**
 * 单价从环境变量读（USD / 百万 token）。
 *
 * 两个变量都给了有效非负数才算配好；只给一个、给空串、给非数字都按"没配"处理，
 * 报告里的 usd 于是是 null 而不是一个凭空的 0。
 */
export function pricingFromEnv(env: NodeJS.ProcessEnv = process.env): EvalPricing | null {
  const input = parsePrice(env[PRICE_INPUT_ENV])
  const output = parsePrice(env[PRICE_OUTPUT_ENV])
  if (input === null || output === null) return null
  return { inputPerMTok: input, outputPerMTok: output }
}

function parsePrice(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

export interface EvalCaseResult {
  id: string
  goal: string
  /** case 维度：报告与指标按它分组（读链路 vs 写链路） */
  type: EvalCaseType
  status: 'completed' | 'failed' | 'unknown'
  latencyMs: number
  verdict: CaseVerdict
  /** 计划里的工具调用能力名，按顺序 */
  toolCalls: string[]
  failedToolCalls: number
  budgetExhausted: boolean
  verificationOk: boolean | null
  modelUsage: ModelUsagePayload | null
  /** 这条 case 实际跑了多少次（runs>1 是 pass^k / pass@k 口径） */
  runs: number
  /** 每一次跑的 fullSuccess，按跑的顺序。runs=1 时长度为 1 */
  runResults: boolean[]
  /** 至少一次成功（pass@k）。runs=1 时与 verdict.fullSuccess 相同 */
  passAtK: boolean
}

export interface EvalGate {
  id: string
  label: string
  pass: boolean
  /** 实测值，已经格式化成人话（"18/20"、"97.5%"） */
  observed: string
  threshold: string
}

export interface EvalMetrics {
  cases: number
  completed: number
  fullSuccess: number
  /** 完整成功 / 总条数。REQ-011 的 ≥18/20 按它判。runs>1 时这是 pass^k 口径
   * （verdict 取第一次失败的跑，所以 fullSuccess 数的是「每次都过」的 case） */
  successRate: number
  /** 至少一次成功 / 总条数（pass@k 口径）。runs=1 时与 successRate 相等 */
  passAtKRate: number
  /** 终态 completed / 总条数。与 successRate 分开：终态过了不代表要点齐 */
  completionRate: number
  /** 按维度分组：读链路与写链路的强弱项一眼分开。key 排序过，报告可 diff */
  byType: Record<string, { cases: number; fullSuccess: number; successRate: number }>
  pageRefs: { facts: number; grounded: number; ungrounded: number; accuracy: number }
  keyPoints: { total: number; hit: number; recall: number }
  tools: {
    calls: number
    failed: number
    byCapability: Record<string, number>
    budgetExhaustedCases: number
  }
  cost: {
    inputTokens: number
    outputTokens: number
    /** pricing 没配就是 null（不是 0）：0 会读成"免费"，null 才是"没算" */
    usd: number | null
    pricingSource: 'env' | 'unset'
  }
  latencyMs: { total: number; mean: number; p95: number; max: number }
  gates: EvalGate[]
}

/**
 * 指导书 §2 Phase 3 Exit Checklist 的阈值：完整成功 ≥18/20（REQ-011）、
 * 页面引用准确率 ≥95%、关键结论召回 ≥90%（TEST-014）。
 */
export const GATE_THRESHOLDS = {
  fullSuccessRate: 0.9,
  pageRefAccuracy: 0.95,
  keyPointRecall: 0.9
} as const

/** 延迟报告用 p95：均值会把一条卡住 30 秒的 case 摊薄成"整体还行" */
const P95 = 0.95

export function summarize(
  results: readonly EvalCaseResult[],
  pricing: EvalPricing | null
): EvalMetrics {
  const cases = results.length
  const completed = results.filter((r) => r.status === 'completed').length
  const fullSuccess = results.filter((r) => r.verdict.fullSuccess).length

  const facts = sum(results, (r) => r.verdict.facts)
  const grounded = sum(results, (r) => r.verdict.groundedFacts)
  const hitKeyPoints = sum(results, (r) => r.verdict.hitKeyPoints.length)
  const missedKeyPoints = sum(results, (r) => r.verdict.missedKeyPoints.length)
  const keyPointTotal = hitKeyPoints + missedKeyPoints

  const inputTokens = sum(results, (r) => r.modelUsage?.inputTokens ?? 0)
  const outputTokens = sum(results, (r) => r.modelUsage?.outputTokens ?? 0)

  const latencies = results.map((r) => r.latencyMs)
  const budgetExhaustedCases = results.filter((r) => r.budgetExhausted).length
  const accuracy = ratio(grounded, facts)
  const recall = ratio(hitKeyPoints, keyPointTotal)

  return {
    cases,
    completed,
    fullSuccess,
    successRate: round(ratio(fullSuccess, cases), 4),
    passAtKRate: round(ratio(results.filter((r) => r.passAtK).length, cases), 4),
    completionRate: round(ratio(completed, cases), 4),
    byType: byType(results),
    pageRefs: { facts, grounded, ungrounded: facts - grounded, accuracy: round(accuracy, 4) },
    keyPoints: {
      total: keyPointTotal,
      hit: hitKeyPoints,
      recall: round(recall, 4)
    },
    tools: {
      calls: sum(results, (r) => r.toolCalls.length),
      failed: sum(results, (r) => r.failedToolCalls),
      byCapability: countByCapability(results),
      budgetExhaustedCases
    },
    cost: {
      inputTokens,
      outputTokens,
      usd: pricing === null ? null : round(costOf(inputTokens, outputTokens, pricing), 6),
      pricingSource: pricing === null ? 'unset' : 'env'
    },
    latencyMs: {
      total: round(
        sum(results, (r) => r.latencyMs),
        1
      ),
      mean: round(cases === 0 ? 0 : sum(results, (r) => r.latencyMs) / cases, 1),
      p95: round(percentile(latencies, P95), 1),
      max: round(latencies.length === 0 ? 0 : Math.max(...latencies), 1)
    },
    gates: evaluateGates({ cases, fullSuccess, accuracy, recall, budgetExhaustedCases })
  }
}

export function evaluateGates(input: {
  cases: number
  fullSuccess: number
  accuracy: number
  recall: number
  budgetExhaustedCases: number
}): EvalGate[] {
  const required = Math.ceil(GATE_THRESHOLDS.fullSuccessRate * input.cases)
  return [
    {
      id: 'req-011-full-success',
      label: '完整成功（REQ-011）',
      pass: input.cases > 0 && input.fullSuccess >= required,
      observed: `${input.fullSuccess}/${input.cases}`,
      threshold: `≥ ${required}/${input.cases}`
    },
    {
      id: 'test-014-page-refs',
      label: '页面引用准确率（TEST-014）',
      pass: input.accuracy >= GATE_THRESHOLDS.pageRefAccuracy,
      observed: percent(input.accuracy),
      threshold: `≥ ${percent(GATE_THRESHOLDS.pageRefAccuracy)}`
    },
    {
      id: 'test-014-recall',
      label: '关键结论召回率（TEST-014）',
      pass: input.recall >= GATE_THRESHOLDS.keyPointRecall,
      observed: percent(input.recall),
      threshold: `≥ ${percent(GATE_THRESHOLDS.keyPointRecall)}`
    },
    {
      id: 'no-budget-exhausted',
      label: '无预算耗尽',
      pass: input.budgetExhaustedCases === 0,
      observed: `${input.budgetExhaustedCases} 条`,
      threshold: '0 条'
    }
  ]
}

function costOf(inputTokens: number, outputTokens: number, pricing: EvalPricing): number {
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000
}

function countByCapability(results: readonly EvalCaseResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const result of results) {
    for (const capability of result.toolCalls) {
      counts[capability] = (counts[capability] ?? 0) + 1
    }
  }
  // key 排序后重建：报告要能被逐行 diff，插入顺序取决于跑的顺序，不稳定。
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/** 按维度分组的成功率。key 排序，与 byCapability 同一个理由 */
function byType(results: readonly EvalCaseResult[]): EvalMetrics['byType'] {
  const groups = new Map<string, { cases: number; fullSuccess: number }>()
  for (const result of results) {
    const group = groups.get(result.type) ?? { cases: 0, fullSuccess: 0 }
    group.cases += 1
    if (result.verdict.fullSuccess) group.fullSuccess += 1
    groups.set(result.type, group)
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, group]) => [
        type,
        { ...group, successRate: round(ratio(group.fullSuccess, group.cases), 4) }
      ])
  )
}

/** 最近秩（nearest-rank）分位：n=20 时 p95 取第 19 个样本，不做插值 */
function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(fraction * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function sum(results: readonly EvalCaseResult[], pick: (result: EvalCaseResult) => number): number {
  return results.reduce((total, result) => total + pick(result), 0)
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
