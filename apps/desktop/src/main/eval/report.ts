import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { z } from 'zod'

import { summarize, type EvalCaseResult, type EvalPricing } from './metrics'
import { ModelUsagePayload } from './observation'
import { EvalCaseType } from './case-manifest'

/**
 * Live Eval 的结果报告。
 *
 * 报告是留给人的产物：跑完之后用不着翻日志，打开 JSON 就能看出成功率、页码、
 * 工具、成本、延迟分别落在哪。所以它有自己的 schema 与 schemaVersion——
 * 将来改形状时靠版本号区分新旧报告，而不是靠"看起来差不多"。
 */

/** 固定文案：写清这一轮测的是哪条链路，读报告的人不必回头翻代码。
 *  TASK-028 起计划按可见能力伸缩，所以这里点明是「只读配置」——报告里的成功率
 *  只覆盖读链路，完整 Golden Path（移动 + Reminder）在 e2e/golden-path.test.ts 里验。 */
export const REPORT_SCOPE =
  '只读配置：握手只下发 filesystem_list 与 document_extract_pdf（计划因此是三步），量的是文档摘要；不改动授权根内容，不涉及 WRITE 能力与权限批准'

const EvalGateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pass: z.boolean(),
  observed: z.string().min(1),
  threshold: z.string().min(1)
})

const EvalMetricsSchema = z.object({
  cases: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  fullSuccess: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  passAtKRate: z.number().min(0).max(1),
  completionRate: z.number().min(0).max(1),
  byType: z.record(
    z.string(),
    z.object({
      cases: z.number().int().nonnegative(),
      fullSuccess: z.number().int().nonnegative(),
      successRate: z.number().min(0).max(1)
    })
  ),
  pageRefs: z.object({
    facts: z.number().int().nonnegative(),
    grounded: z.number().int().nonnegative(),
    ungrounded: z.number().int().nonnegative(),
    accuracy: z.number().min(0).max(1)
  }),
  keyPoints: z.object({
    total: z.number().int().nonnegative(),
    hit: z.number().int().nonnegative(),
    recall: z.number().min(0).max(1)
  }),
  tools: z.object({
    calls: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    byCapability: z.record(z.string(), z.number().int().nonnegative()),
    budgetExhaustedCases: z.number().int().nonnegative()
  }),
  cost: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    usd: z.number().nonnegative().nullable(),
    pricingSource: z.enum(['env', 'unset'])
  }),
  latencyMs: z.object({
    total: z.number().nonnegative(),
    mean: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    max: z.number().nonnegative()
  }),
  gates: z.array(EvalGateSchema)
})

const EvalCaseReportSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  /** case 维度。老报告（v1 早期）没有这个字段，可选 */
  type: EvalCaseType.optional(),
  status: z.enum(['completed', 'failed', 'unknown']),
  latencyMs: z.number().nonnegative(),
  facts: z.number().int().nonnegative(),
  groundedFacts: z.number().int().nonnegative(),
  missedKeyPoints: z.array(z.string()),
  selectedTarget: z.boolean(),
  toolCalls: z.array(z.string()),
  failedToolCalls: z.number().int().nonnegative(),
  budgetExhausted: z.boolean(),
  verificationOk: z.boolean().nullable(),
  modelUsage: ModelUsagePayload.nullable(),
  costUsd: z.number().nonnegative().nullable(),
  reasons: z.array(z.string()),
  /** stateful 终态断言结论；null/缺省 = 不适用（读链路） */
  finalStateOk: z.boolean().nullable().optional(),
  /** 重复跑的口径（pass^k / pass@k）。老报告缺省按 runs=1 读 */
  runs: z.number().int().positive().optional(),
  runResults: z.array(z.boolean()).optional(),
  passAtK: z.boolean().optional()
})

export const EvalReportSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(['scripted', 'live']),
  /** 真模型名（live）；scripted 模式是 null */
  model: z.string().min(1).nullable(),
  scope: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
  manifestPath: z.string().min(1),
  metrics: EvalMetricsSchema,
  cases: z.array(EvalCaseReportSchema)
})

export type EvalReport = z.infer<typeof EvalReportSchema>

export interface ReportInput {
  mode: 'scripted' | 'live'
  model: string | null
  manifestPath: string
  startedAt: string
  finishedAt: string
  results: readonly EvalCaseResult[]
  pricing: EvalPricing | null
}

export function buildReport(input: ReportInput): EvalReport {
  const metrics = summarize(input.results, input.pricing)
  const startedMs = Date.parse(input.startedAt)
  const finishedMs = Date.parse(input.finishedAt)

  return {
    schemaVersion: 1,
    mode: input.mode,
    model: input.model,
    scope: REPORT_SCOPE,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Number.isNaN(startedMs) || Number.isNaN(finishedMs) ? 0 : finishedMs - startedMs,
    manifestPath: input.manifestPath,
    metrics,
    cases: input.results.map((result) => ({
      id: result.id,
      goal: result.goal,
      type: result.type,
      status: result.status,
      latencyMs: result.latencyMs,
      facts: result.verdict.facts,
      groundedFacts: result.verdict.groundedFacts,
      missedKeyPoints: result.verdict.missedKeyPoints,
      selectedTarget: result.verdict.selectedTarget,
      toolCalls: result.toolCalls,
      failedToolCalls: result.failedToolCalls,
      budgetExhausted: result.budgetExhausted,
      verificationOk: result.verificationOk,
      modelUsage: result.modelUsage,
      costUsd: costOf(result, input.pricing),
      reasons: result.verdict.reasons,
      finalStateOk: result.verdict.finalStateOk,
      runs: result.runs,
      runResults: result.runResults,
      passAtK: result.passAtK
    }))
  }
}

/** 写盘。返回写入的绝对路径，调用方（CLI 入口）把它打出来给人看 */
export function writeReport(report: EvalReport, path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return path
}

/** 一屏摘要：跑的人先看这个，细节再翻 JSON */
export function formatSummary(report: EvalReport): string {
  const { metrics } = report
  const byType = Object.entries(metrics.byType)
    .map(([type, g]) => `${type} ${g.fullSuccess}/${g.cases}`)
    .join('｜')
  const runsNote =
    metrics.passAtKRate === metrics.successRate
      ? ''
      : `｜pass@k ${(metrics.passAtKRate * 100).toFixed(1)}%`
  const lines = [
    `模式 ${report.mode}${report.model === null ? '' : `（${report.model}）`}｜${report.scope}`,
    `完整成功 ${metrics.fullSuccess}/${metrics.cases}（成功率 ${(metrics.successRate * 100).toFixed(1)}%${runsNote}）` +
      `｜终态 completed ${metrics.completed}/${metrics.cases}`,
    `分维度 ${byType === '' ? '（无）' : byType}`,
    `页码引用 ${metrics.pageRefs.grounded}/${metrics.pageRefs.facts}（${(metrics.pageRefs.accuracy * 100).toFixed(1)}%）` +
      `｜关键结论召回 ${metrics.keyPoints.hit}/${metrics.keyPoints.total}（${(metrics.keyPoints.recall * 100).toFixed(1)}%）`,
    `工具调用 ${metrics.tools.calls} 次（失败 ${metrics.tools.failed} 次，预算耗尽 ${metrics.tools.budgetExhaustedCases} 条）`,
    `成本 in ${metrics.cost.inputTokens} / out ${metrics.cost.outputTokens} token` +
      `（${metrics.cost.usd === null ? '未配单价，不算美元' : `${metrics.cost.usd} USD`}）`,
    `延迟 合计 ${metrics.latencyMs.total}ms｜均值 ${metrics.latencyMs.mean}ms｜p95 ${metrics.latencyMs.p95}ms｜最大 ${metrics.latencyMs.max}ms`,
    `闸口 ${metrics.gates.map((g) => `${g.pass ? '✅' : '❌'} ${g.label} ${g.observed}（要求 ${g.threshold}）`).join('｜')}`
  ]
  return lines.join('\n')
}

function costOf(result: EvalCaseResult, pricing: EvalPricing | null): number | null {
  if (pricing === null || result.modelUsage === null) return null
  const usd =
    (result.modelUsage.inputTokens * pricing.inputPerMTok +
      result.modelUsage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000
}

// ---------- 模型选型的配对比较（第七章口径） ----------

export interface PairComparison {
  aModel: string | null
  bModel: string | null
  /** 参与配对的 case 数（两边 id 的交集；只跑过一边的进 unpaired） */
  cases: number
  /** 只在 A 通过的 case id */
  aWins: string[]
  /** 只在 B 通过的 case id */
  bWins: string[]
  bothPass: number
  bothFail: number
  /** 两边 id 对不上的 case（跑的清单不同版），比较前先看这里 */
  unpaired: string[]
}

/**
 * 两份报告逐 case 配对。配对比较只看不一致的对子（discordant pairs）——两个模型
 * 都过或都挂的 case 不携带分辨信息，这是 n 小的时候唯一有分辨力的比法。
 *
 * 读数的规矩：discordant 少于 5 时，「A 比 B 好」多半在噪声里，先扩 case 或多跑
 * 几轮再下结论；分维度 rates 只是给方向，不替代逐对计数。
 */
export function compareReports(a: EvalReport, b: EvalReport): PairComparison {
  const ok = (report: EvalReport, id: string): boolean | undefined => {
    const found = report.cases.find((c) => c.id === id)
    return found === undefined ? undefined : found.reasons.length === 0
  }

  const ids = [...new Set([...a.cases.map((c) => c.id), ...b.cases.map((c) => c.id)])].sort(
    (x, y) => x.localeCompare(y)
  )

  const aWins: string[] = []
  const bWins: string[] = []
  const unpaired: string[] = []
  let bothPass = 0
  let bothFail = 0

  for (const id of ids) {
    const aOk = ok(a, id)
    const bOk = ok(b, id)
    if (aOk === undefined || bOk === undefined) {
      unpaired.push(id)
      continue
    }
    if (aOk && !bOk) aWins.push(id)
    else if (!aOk && bOk) bWins.push(id)
    else if (aOk) bothPass += 1
    else bothFail += 1
  }

  return {
    aModel: a.model,
    bModel: b.model,
    cases: ids.length - unpaired.length,
    aWins,
    bWins,
    bothPass,
    bothFail,
    unpaired
  }
}

/** 配对比较的一屏摘要 */
export function formatPairComparison(c: PairComparison): string {
  const noiseNote =
    c.aWins.length + c.bWins.length < 5
      ? '⚠ 不一致的对子 < 5：差异在噪声带宽内，别据此换模型'
      : `不一致对子 ${c.aWins.length + c.bWins.length} 个`
  return [
    `配对比较 ${c.aModel ?? 'A'} vs ${c.bModel ?? 'B'}（配对 ${c.cases} 条${c.unpaired.length > 0 ? `，未配对 ${c.unpaired.length} 条: ${c.unpaired.join(', ')}` : ''}）`,
    `A 独赢 ${c.aWins.length}: ${c.aWins.join(', ') || '—'}`,
    `B 独赢 ${c.bWins.length}: ${c.bWins.join(', ') || '—'}`,
    `双过 ${c.bothPass}｜双挂 ${c.bothFail}｜${noiseNote}`
  ].join('\n')
}
