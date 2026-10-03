import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CaseVerdict } from '../../../src/main/eval/judge'
import type { EvalCaseResult } from '../../../src/main/eval/metrics'
import {
  EvalReportSchema,
  REPORT_SCOPE,
  buildReport,
  compareReports,
  formatPairComparison,
  formatSummary,
  writeReport,
  type ReportInput
} from '../../../src/main/eval/report'

/**
 * 报告的形状与写盘。
 *
 * 报告是留给人的产物，schema 是它的契约：`buildReport` 的产物必须能被
 * `EvalReportSchema` 解析（同一份断言也在 run-eval 的 E2E 里跑一次），
 * 形状变了就改版本号，而不是让旧报告与新报告长得像但语义不同。
 */

let dir = ''

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const VERDICT: CaseVerdict = {
  fullSuccess: true,
  facts: 2,
  groundedFacts: 2,
  ungroundedFacts: 0,
  hitKeyPoints: ['kp-1'],
  missedKeyPoints: [],
  selectedTarget: true,
  reasons: [],
  finalStateOk: null
}

function makeResult(over: Partial<EvalCaseResult> = {}): EvalCaseResult {
  const fullSuccess = over.verdict?.fullSuccess ?? true
  return {
    id: 'one-page-note',
    goal: '总结这份 PDF',
    type: 'pdf_summary',
    status: 'completed',
    latencyMs: 42.5,
    verdict: VERDICT,
    toolCalls: ['filesystem_list', 'document_extract_pdf'],
    failedToolCalls: 0,
    budgetExhausted: false,
    verificationOk: true,
    modelUsage: null,
    runs: 1,
    runResults: [fullSuccess],
    passAtK: fullSuccess,
    ...over
  }
}

function makeInput(
  results: EvalCaseResult[],
  pricing: { inputPerMTok: number; outputPerMTok: number } | null = null
): ReportInput {
  return {
    mode: 'scripted' as const,
    model: null,
    manifestPath: 'tests/evals/cases.json',
    startedAt: '2026-09-16T10:00:00.000Z',
    finishedAt: '2026-09-16T10:00:08.500Z',
    results,
    pricing
  }
}

describe('buildReport', () => {
  it('产物过得去自己的 schema，时长由两个时间戳算出', () => {
    const report = buildReport(makeInput([makeResult()]))

    const parsed = EvalReportSchema.safeParse(report)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(report.schemaVersion).toBe(1)
    expect(report.durationMs).toBe(8500)
    expect(report.scope).toBe(REPORT_SCOPE)
    expect(report.model).toBeNull()
  })

  it('逐条 case 带着判定明细与闸口结论', () => {
    const report = buildReport(
      makeInput([
        makeResult(),
        makeResult({
          id: 'missed',
          status: 'failed',
          verificationOk: false,
          verdict: { ...VERDICT, fullSuccess: false, missedKeyPoints: ['kp-2'] },
          budgetExhausted: true
        })
      ])
    )

    expect(report.cases).toHaveLength(2)
    expect(report.cases[0]?.id).toBe('one-page-note')
    expect(report.cases[1]?.budgetExhausted).toBe(true)
    expect(report.metrics.cases).toBe(2)
    expect(report.metrics.gates).toHaveLength(4)
  })

  it('逐条成本按单价折算；没配单价就是 null', () => {
    const usage = { model: 'gpt-test', inputTokens: 1_000_000, outputTokens: 0, calls: 1 }

    const priced = buildReport(
      makeInput([makeResult({ modelUsage: usage })], { inputPerMTok: 2, outputPerMTok: 8 })
    )
    const unpriced = buildReport(makeInput([makeResult({ modelUsage: usage })]))

    expect(priced.cases[0]?.costUsd).toBe(2)
    expect(unpriced.cases[0]?.costUsd).toBeNull()
    expect(unpriced.metrics.cost.usd).toBeNull()
  })

  it('live 模式记下模型名，scripted 模式是 null', () => {
    const report = buildReport({ ...makeInput([makeResult()]), mode: 'live', model: 'gpt-test' })

    expect(report.mode).toBe('live')
    expect(report.model).toBe('gpt-test')
  })
})

describe('writeReport / formatSummary', () => {
  it('写盘：JSON 能被读回并过 schema', () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-eval-report-'))
    const path = join(dir, 'nested', 'report.json')
    const report = buildReport(makeInput([makeResult()]))

    const written = writeReport(report, path)

    expect(written).toBe(path)
    expect(EvalReportSchema.safeParse(JSON.parse(readFileSync(path, 'utf8'))).success).toBe(true)
  })

  it('一屏摘要：成功率、页码、工具、成本、延迟、闸口都在', () => {
    const summary = formatSummary(buildReport(makeInput([makeResult()])))

    expect(summary).toContain('完整成功 1/1')
    expect(summary).toContain('成功率 100.0%')
    expect(summary).toContain('页码引用 2/2')
    expect(summary).toContain('关键结论召回 1/1')
    expect(summary).toContain('工具调用 2 次')
    expect(summary).toContain('未配单价')
    expect(summary).toContain('延迟')
    expect(summary).toContain('完整成功（REQ-011）')
  })
})

// ---------- 配对比较（模型选型口径） ----------

/** 两份报告：A 在 c2 上挂、B 在 c3 上挂，其余都过 */
function pairInputs(): [ReportInput, ReportInput] {
  const verdictFail = { ...VERDICT, fullSuccess: false, reasons: ['漏掉了要点：kp-1'] }
  return [
    makeInput([
      makeResult({ id: 'c1' }),
      makeResult({ id: 'c2', verdict: verdictFail }),
      makeResult({ id: 'c3' })
    ]),
    makeInput([
      makeResult({ id: 'c1' }),
      makeResult({ id: 'c2' }),
      makeResult({ id: 'c3', verdict: verdictFail })
    ])
  ]
}

describe('compareReports', () => {
  it('逐 case 配对：不一致的对子分别记到两边，双过双挂分开放', () => {
    const [a, b] = pairInputs()
    const comparison = compareReports(buildReport(a), buildReport(b))

    expect(comparison.cases).toBe(3)
    expect(comparison.aWins).toEqual(['c3'])
    expect(comparison.bWins).toEqual(['c2'])
    expect(comparison.bothPass).toBe(1)
    expect(comparison.bothFail).toBe(0)
    expect(comparison.unpaired).toEqual([])
  })

  it('两边清单版本不同时，对不上的 id 进 unpaired，不参与计数', () => {
    const [a, b] = pairInputs()
    const aReport = buildReport({ ...a, results: [...a.results, makeResult({ id: 'c9' })] })
    const comparison = compareReports(aReport, buildReport(b))

    expect(comparison.unpaired).toEqual(['c9'])
    expect(comparison.cases).toBe(3)
  })

  it('一屏摘要：模型名、独赢清单与噪声提醒都在', () => {
    const [a, b] = pairInputs()
    const aReport = buildReport({ ...a, model: 'model-a' })
    const bReport = buildReport({ ...b, model: 'model-b' })
    const text = formatPairComparison(compareReports(aReport, bReport))

    expect(text).toContain('model-a vs model-b')
    expect(text).toContain('A 独赢 1: c3')
    expect(text).toContain('B 独赢 1: c2')
    // 不一致对子 = 2，小于 5，必须把噪声话说在前面
    expect(text).toContain('噪声带宽内')
  })
})
