import { describe, expect, it } from 'vitest'

import type { EvalCase } from './case-manifest'
import { judgeCase, type CaseObservation } from './judge'

/**
 * 判定表的逐条验收（TASK-027）。
 *
 * 一条用例锁一条判据：六条判据各有一个"就差这一点"的场景，加上 fail-closed 底线。
 * 断言是判定表唯一的规格说明——判据改了这里必须跟着改，改不动就说明口径变了。
 *
 * 判据本身写在 judge.ts 的 judgeCase 上方（六条 + 边界）。这里的场景故意做成
 * 微小差异：只有一条 fact 越界、只漏一个要点、只错一个文件名——一次只验一条判据，
 * 红了立刻知道是哪条。
 */

const TARGET = 'invoice-2026-03.pdf'

/** 两条要点：一条在第 1 页，一条在第 3 页。第二份 PDF 是选择干扰项 */
function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'judge-fixture',
    goal: '总结 invoice-2026-03.pdf，带页码引用',
    pdfs: [
      { name: TARGET, pages: ['total is 4800 USD', ' ', 'due on 2026-04-15'] },
      { name: 'notes.pdf', pages: ['scratch notes'] }
    ],
    extraFiles: [],
    target: TARGET,
    keyPoints: [
      { id: 'total', text: '总额 4800 USD', keywords: ['4800'], pages: [1] },
      { id: 'due', text: '到期日 2026-04-15', keywords: ['2026-04-15'], pages: [3] }
    ],
    ...overrides
  }
}

function makeObservation(overrides: Partial<CaseObservation> = {}): CaseObservation {
  return {
    caseId: 'judge-fixture',
    taskId: 'task-1',
    status: 'completed',
    facts: [
      { text: '这张发票总额是 4800 USD', pageRefs: [1] },
      { text: '到期日为 2026-04-15', pageRefs: [3] }
    ],
    realPageNumbers: [1, 2, 3],
    toolCalls: [
      { capability: 'filesystem_list', arguments: { rootId: 'downloads' } },
      { capability: 'document_extract_pdf', arguments: { path: `D:/downloads/${TARGET}` } }
    ],
    extractedPaths: [`D:/downloads/${TARGET}`],
    budgetExhausted: false,
    verificationOk: true,
    failedToolCalls: 0,
    ...overrides
  }
}

describe('judgeCase：六条判据都满足', () => {
  it('摘要、页码、要点、选文件都对 → 完整成功', () => {
    const verdict = judgeCase(makeCase(), makeObservation())

    expect(verdict.fullSuccess).toBe(true)
    expect(verdict.facts).toBe(2)
    expect(verdict.groundedFacts).toBe(2)
    expect(verdict.ungroundedFacts).toBe(0)
    expect(verdict.hitKeyPoints).toEqual(['total', 'due'])
    expect(verdict.missedKeyPoints).toEqual([])
    expect(verdict.selectedTarget).toBe(true)
    expect(verdict.reasons).toEqual([])
  })
})

describe('judgeCase：页码判据', () => {
  it('有一条 fact 引用了不存在的页 → 这一条不算 grounded', () => {
    const observation = makeObservation({
      facts: [
        { text: '这张发票总额是 4800 USD', pageRefs: [1] },
        { text: '到期日为 2026-04-15', pageRefs: [3, 7] }
      ]
    })

    const verdict = judgeCase(makeCase(), observation)

    expect(verdict.groundedFacts).toBe(1)
    expect(verdict.ungroundedFacts).toBe(1)
    expect(verdict.fullSuccess).toBe(false)
    // 点名的是越界页（7），而且**只点名那一条**：合格的那条不能被牵连
    // （判据里判的是"这条 fact 自己没通过"，不是"已经有 fact 没通过"）。
    expect(verdict.reasons).toHaveLength(1)
    expect(verdict.reasons[0]).toContain('7')
  })

  it('页集合拿不到（PDF 读不出来）→ 一条都不许算 grounded', () => {
    const observation = makeObservation({ realPageNumbers: null })

    const verdict = judgeCase(makeCase(), observation)

    // 契约底线：拿不到页集合 != 页码可信。
    expect(verdict.groundedFacts).toBe(0)
    expect(verdict.ungroundedFacts).toBe(observation.facts.length)
    expect(verdict.fullSuccess).toBe(false)
  })
})

describe('judgeCase：要点判据', () => {
  it('摘要少了一条要点 → 记进 missedKeyPoints', () => {
    const observation = makeObservation({
      facts: [{ text: '这张发票总额是 4800 USD', pageRefs: [1] }]
    })

    const verdict = judgeCase(makeCase(), observation)

    expect(verdict.hitKeyPoints).toEqual(['total'])
    expect(verdict.missedKeyPoints).toEqual(['due'])
    expect(verdict.fullSuccess).toBe(false)
  })

  it('尺寸写不同也认：关键词匹配不看大小写', () => {
    const evalCase = makeCase({
      keyPoints: [
        { id: 'total', text: '总额 4800 USD', keywords: ['4800 usd'], pages: [1] },
        { id: 'due', text: '到期日', keywords: ['2026-04-15'], pages: [3] }
      ]
    })

    const verdict = judgeCase(
      evalCase,
      makeObservation({ facts: [{ text: '总额 4800 USD', pageRefs: [1] }] })
    )

    // 关键词小写、正文大写也算命中；另一条要点正文里真的没有，照样记漏。
    expect(verdict.hitKeyPoints).toEqual(['total'])
    expect(verdict.missedKeyPoints).toEqual(['due'])
  })

  it('一条 fact 都没有 → 不完整成功（不能靠空集合真空满足）', () => {
    const verdict = judgeCase(makeCase(), makeObservation({ facts: [] }))

    expect(verdict.fullSuccess).toBe(false)
    expect(verdict.groundedFacts).toBe(0)
    expect(verdict.ungroundedFacts).toBe(0)
    expect(verdict.missedKeyPoints).toEqual(['total', 'due'])
    expect(verdict.reasons).toContain('没有任何事实')
  })
})

describe('judgeCase：状态与执行判据', () => {
  it('Python 说完成但闸口拒了（任务终态 failed）→ 不完整成功', () => {
    const verdict = judgeCase(
      makeCase(),
      makeObservation({ status: 'failed', verificationOk: false })
    )

    const reasons = verdict.reasons.join('\n')
    expect(verdict.fullSuccess).toBe(false)
    // 原因里既要说清期望是什么（completed），也要带上实际值（failed）。
    expect(reasons).toContain('completed')
    expect(reasons).toContain('failed')
  })

  it('提取的是干扰文件，而且预算耗尽 → 两条原因都要在', () => {
    const observation = makeObservation({
      extractedPaths: ['D:/downloads/notes.pdf'],
      toolCalls: [
        { capability: 'document_extract_pdf', arguments: { path: 'D:/downloads/notes.pdf' } }
      ],
      budgetExhausted: true
    })

    const verdict = judgeCase(makeCase(), observation)

    const reasons = verdict.reasons.join('\n')
    expect(verdict.selectedTarget).toBe(false)
    expect(verdict.fullSuccess).toBe(false)
    // 文件名比的是 basename：拿绝对路径去比 target（只是个文件名）永远不等。
    expect(reasons).toContain('目标 PDF')
    expect(reasons).toContain('budget_exhausted')
  })
})
