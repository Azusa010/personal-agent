import { describe, expect, it } from 'vitest'

import type { CaseVerdict } from './judge'
import {
  GATE_THRESHOLDS,
  PRICE_INPUT_ENV,
  PRICE_OUTPUT_ENV,
  pricingFromEnv,
  summarize,
  type EvalCaseResult
} from './metrics'

/**
 * 统计口径的验收。
 *
 * 判定（judgeCase）与统计分开测：统计是纯算术，输入的判定结果直接给，
 * 这样断言的是"多少个事实算出了什么比例"，与判定表怎么判解耦。
 */

function makeVerdict(over: Partial<CaseVerdict> = {}): CaseVerdict {
  return {
    fullSuccess: true,
    facts: 2,
    groundedFacts: 2,
    ungroundedFacts: 0,
    hitKeyPoints: ['kp-1'],
    missedKeyPoints: [],
    selectedTarget: true,
    reasons: [],
    ...over
  }
}

function makeResult(over: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    id: 'c',
    goal: 'g',
    status: 'completed',
    latencyMs: 100,
    verdict: makeVerdict(),
    toolCalls: ['filesystem_list', 'document_extract_pdf'],
    failedToolCalls: 0,
    budgetExhausted: false,
    verificationOk: true,
    modelUsage: null,
    ...over
  }
}

describe('summarize：计数与比值', () => {
  it('成功率按完整成功算，完成率按任务终态算，两者分开', () => {
    const results = [
      makeResult(),
      // 终态 completed，但摘要漏了要点：完整成功为假，完成率仍算它
      makeResult({
        verdict: makeVerdict({ fullSuccess: false, missedKeyPoints: ['kp-2'] })
      }),
      makeResult({
        status: 'failed',
        verdict: makeVerdict({ fullSuccess: false, facts: 0, groundedFacts: 0, hitKeyPoints: [] })
      })
    ]

    const metrics = summarize(results, null)

    expect(metrics.cases).toBe(3)
    expect(metrics.completed).toBe(2)
    expect(metrics.fullSuccess).toBe(1)
    expect(metrics.successRate).toBe(0.3333)
    expect(metrics.completionRate).toBe(0.6667)
  })

  it('页码准确率与要点召回率按逐条计数汇总', () => {
    const results = [
      makeResult({ verdict: makeVerdict({ facts: 4, groundedFacts: 3, ungroundedFacts: 1 }) }),
      makeResult({
        verdict: makeVerdict({
          facts: 2,
          groundedFacts: 2,
          hitKeyPoints: ['a', 'b'],
          missedKeyPoints: ['c']
        })
      })
    ]

    const metrics = summarize(results, null)

    expect(metrics.pageRefs).toEqual({ facts: 6, grounded: 5, ungrounded: 1, accuracy: 0.8333 })
    // 要点总数 = 命中 + 漏掉：第一条 1 个命中，第二条 2 命中 1 漏 → 3/4
    expect(metrics.keyPoints).toEqual({ total: 4, hit: 3, recall: 0.75 })
  })

  it('一条 case 都没有时全报 0，不出现 NaN', () => {
    const metrics = summarize([], null)

    expect(metrics.successRate).toBe(0)
    expect(metrics.pageRefs.accuracy).toBe(0)
    expect(metrics.keyPoints.recall).toBe(0)
    expect(metrics.latencyMs.mean).toBe(0)
    // NaN 在 JSON 里会变成 null，读报告的人分不清"没跑"与"算错"。
    // 有意的 null 只有 cost.usd（未配单价），其余一律不许出现。
    const withoutCost: Record<string, unknown> = { ...metrics }
    delete withoutCost['cost']
    expect(JSON.stringify(withoutCost)).not.toContain('null')
  })

  it('工具统计按能力名计数，key 排序稳定（报告要能逐行 diff）', () => {
    const results = [
      makeResult({ toolCalls: ['filesystem_list', 'document_extract_pdf'] }),
      makeResult({ toolCalls: ['filesystem_list'], failedToolCalls: 1, budgetExhausted: true })
    ]

    const metrics = summarize(results, null)

    expect(metrics.tools.calls).toBe(3)
    expect(metrics.tools.failed).toBe(1)
    expect(metrics.tools.budgetExhaustedCases).toBe(1)
    expect(Object.keys(metrics.tools.byCapability)).toEqual([
      'document_extract_pdf',
      'filesystem_list'
    ])
    expect(metrics.tools.byCapability['filesystem_list']).toBe(2)
  })

  it('延迟给合计、均值、p95 与最大值：p95 取最近秩，不做插值', () => {
    const results = Array.from({ length: 20 }, (_, i) => makeResult({ latencyMs: i + 1 }))

    const metrics = summarize(results, null)

    expect(metrics.latencyMs.max).toBe(20)
    expect(metrics.latencyMs.mean).toBe(10.5)
    // 20 个样本的 p95 是第 19 个（19），不是 19.05。
    expect(metrics.latencyMs.p95).toBe(19)
    expect(metrics.latencyMs.total).toBe(210)
  })
})

describe('summarize：成本', () => {
  it('没配单价：token 照记，美元报 null（不是 0）', () => {
    const results = [
      makeResult({
        modelUsage: { model: 'gpt-test', inputTokens: 1000, outputTokens: 200, calls: 3 }
      })
    ]

    const metrics = summarize(results, null)

    expect(metrics.cost.inputTokens).toBe(1000)
    expect(metrics.cost.outputTokens).toBe(200)
    expect(metrics.cost.usd).toBeNull()
    expect(metrics.cost.pricingSource).toBe('unset')
  })

  it('配了单价：按百万 token 折算', () => {
    const results = [
      makeResult({
        modelUsage: { model: 'gpt-test', inputTokens: 1200, outputTokens: 300, calls: 1 }
      })
    ]

    const metrics = summarize(results, { inputPerMTok: 1.5, outputPerMTok: 6 })

    // 1200 * 1.5 / 1e6 + 300 * 6 / 1e6
    expect(metrics.cost.usd).toBe(0.0036)
    expect(metrics.cost.pricingSource).toBe('env')
  })

  it('scripted 模式没有用量事件：token 报 0，不算错', () => {
    const metrics = summarize([makeResult()], { inputPerMTok: 1, outputPerMTok: 1 })

    expect(metrics.cost.inputTokens).toBe(0)
    expect(metrics.cost.usd).toBe(0)
  })
})

describe('summarize：闸口', () => {
  it('19/20 全对、准确率与召回都达标 → 四个闸口全过', () => {
    // 19 条：5 条 fact 全 grounded；1 条全未 grounded → 95/100
    const results = [
      ...Array.from({ length: 19 }, () =>
        makeResult({ verdict: makeVerdict({ facts: 5, groundedFacts: 5 }) })
      ),
      makeResult({
        verdict: makeVerdict({
          fullSuccess: false,
          facts: 5,
          groundedFacts: 0,
          ungroundedFacts: 5,
          hitKeyPoints: [],
          missedKeyPoints: ['kp-1']
        })
      })
    ]

    const metrics = summarize(results, null)

    expect(metrics.pageRefs.accuracy).toBeCloseTo(0.95, 4)
    expect(metrics.keyPoints.recall).toBeCloseTo(0.95, 4)
    expect(metrics.gates.map((g) => g.pass)).toEqual([true, true, true, true])
    expect(metrics.gates[0]?.observed).toBe('19/20')
    expect(metrics.gates[0]?.threshold).toBe('≥ 18/20')
  })

  it('17/20 全对 → REQ-011 闸口不过，其余仍按各自阈值判', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({ verdict: makeVerdict({ fullSuccess: i < 17 }) })
    )

    const metrics = summarize(results, null)

    expect(metrics.gates.map((g) => g.pass)).toEqual([false, true, true, true])
  })

  it('有预算耗尽 → 该闸口不过', () => {
    const metrics = summarize([makeResult({ budgetExhausted: true })], null)

    const gate = metrics.gates.find((g) => g.id === 'no-budget-exhausted')
    expect(gate?.pass).toBe(false)
    expect(gate?.observed).toBe('1 条')
  })

  it('阈值来自指导书的 Phase 3 Exit Checklist', () => {
    expect(GATE_THRESHOLDS).toEqual({
      fullSuccessRate: 0.9,
      pageRefAccuracy: 0.95,
      keyPointRecall: 0.9
    })
  })
})

describe('pricingFromEnv', () => {
  it('两个变量都给有效值才算配好', () => {
    expect(pricingFromEnv({ [PRICE_INPUT_ENV]: '1.5', [PRICE_OUTPUT_ENV]: '6' })).toEqual({
      inputPerMTok: 1.5,
      outputPerMTok: 6
    })
  })

  it('只给一个、给空串、给非数字、给负数都按没配处理', () => {
    expect(pricingFromEnv({})).toBeNull()
    expect(pricingFromEnv({ [PRICE_INPUT_ENV]: '1.5' })).toBeNull()
    expect(pricingFromEnv({ [PRICE_INPUT_ENV]: '', [PRICE_OUTPUT_ENV]: '6' })).toBeNull()
    expect(pricingFromEnv({ [PRICE_INPUT_ENV]: '便宜', [PRICE_OUTPUT_ENV]: '6' })).toBeNull()
    expect(pricingFromEnv({ [PRICE_INPUT_ENV]: '1.5', [PRICE_OUTPUT_ENV]: '-2' })).toBeNull()
  })
})
