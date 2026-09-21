import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CaseVerdict } from './judge'
import type { EvalCaseResult } from './metrics'
import {
  EvalReportSchema,
  REPORT_SCOPE,
  buildReport,
  formatSummary,
  writeReport,
  type ReportInput
} from './report'

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
  reasons: []
}

function makeResult(over: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    id: 'one-page-note',
    goal: '总结这份 PDF',
    status: 'completed',
    latencyMs: 42.5,
    verdict: VERDICT,
    toolCalls: ['filesystem_list', 'document_extract_pdf'],
    failedToolCalls: 0,
    budgetExhausted: false,
    verificationOk: true,
    modelUsage: null,
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
