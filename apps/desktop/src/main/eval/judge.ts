import { basename } from 'node:path'

import { EXTRACT_PDF_CAPABILITY, type SummaryFact } from '@personal-agent/protocol'

import { targetPdf, type EvalCase } from './case-manifest'

/**
 * 单条 case 的判定表。
 */

/** 计划里的一次工具调用（来自 tool_called 事件） */
export interface CaseToolCall {
  capability: string
  arguments: Record<string, unknown>
}

/** 一条 case 跑完之后取到的事实。判定只读这里，不再碰库、不再读磁盘 */
export interface CaseObservation {
  caseId: string
  taskId: string
  /** 任务终态（product-state 的 tasks.status）；没落库就是 unknown */
  status: 'completed' | 'failed' | 'unknown'
  /** Python 的完成声明（task_completed 事件的 payload.facts）；失败或没测到就是空数组 */
  facts: SummaryFact[]
  /** 目标 PDF 的真实页号集合。取证成功是升序数组，读不出来是 null */
  realPageNumbers: number[] | null
  /** 发生过的工具调用，按顺序 */
  toolCalls: CaseToolCall[]
  /** extract_pdf 调用里出现过的文件绝对路径（正斜杠），按顺序、可能有重复 */
  extractedPaths: string[]
  /** 出现过 budget_exhausted 事件 */
  budgetExhausted: boolean
  /** Main 侧交付物判定的结论（verification_passed / verification_failed 的 payload.report.ok）；没跑到就是 null */
  verificationOk: boolean | null
  /** 工具调用失败的次数（tool_result 里 ok=false 的条数） */
  failedToolCalls: number
}

/** 判定结果。数字部分直接进报告，reasons 进报告的逐条明细 */
export interface CaseVerdict {
  /** 这条 case 是否完整成功。报告的成功率按它算（REQ-011） */
  fullSuccess: boolean
  /** 摘要里的 fact 总数 */
  facts: number
  /** pageRefs 全部落在真实页集合内的 fact 数 */
  groundedFacts: number
  /** 引用了不存在页码（或页集合拿不到）的 fact 数 */
  ungroundedFacts: number
  /** 命中的要点 id */
  hitKeyPoints: string[]
  /** 漏掉的要点 id */
  missedKeyPoints: string[]
  /** 是否提取过期望的那份 PDF（按文件名比对） */
  selectedTarget: boolean
  /** 不通过的原因，逐条人话；通过时是空数组 */
  reasons: string[]
}

/**
 * 判定口径 —— 一条 case 算「完整成功」要同时满足六条：
 *
 * 1. `status === 'completed'`：Main 侧的交付物闸口放行了。Python 自己说完成不算
 *    （PAT-003）。
 * 2. `facts` 非空：一条结论都没有的摘要不是成功，也不能靠「空集合里所有 fact 都
 *    合规」这种真空满足混过去。
 * 3. 每条 fact 的 pageRefs 都落在 `realPageNumbers` 里。`realPageNumbers` 为 null
 *    （PDF 读不出来）时**一条都不算 grounded**——拿不到页集合不等于页码可信，
 *    这是这条判定表的 fail-closed 底线。
 * 4. 清单里每个要点都命中：该要点 keywords 里任意一个（大小写不敏感）出现在任意
 *    一条 fact 的正文里。一条 fact 可以同时命中多个要点，要点也只需要一条 fact 命中。
 * 5. `selectedTarget`：至少有一次 extract_pdf 调用的文件名等于目标 PDF 的文件名。
 *    目录里有多份时这就是「选对了文件」，只有一份时它是「真的去提取了那一份」。
 * 6. 没有 `budgetExhausted`：预算耗尽还能出摘要只是巧合，不算这条用例通过。
 *
 * 返回的 facts / groundedFacts / ungroundedFacts 是**逐条计数**，与 fullSuccess
 * 分开：报告里既要看「多少条 case 全对」，也要看「页码准确率」这种连续指标
 * （TEST-014）。
 *
 * 边界：本函数是纯判定，不读库、不读盘、不抛异常。输入缺东西（没事实、没页集合、
 * 没调用记录）都只能体现为「不通过 + reasons 里那句人话」，因为把异常抛上去的
 * 后果是整份报告写不出来，而不是这一条 case 被记成失败。
 *
 * 对应验收测试：apps/desktop/src/main/eval/judge.test.ts
 */
export function judgeCase(evalCase: EvalCase, observation: CaseObservation): CaseVerdict {
  const reasons: string[] = []

  const status = observation?.status
  const facts = Array.isArray(observation?.facts) ? observation.facts : []
  const realPageNumbers = observation?.realPageNumbers ?? null
  const realPageSet = realPageNumbers ? new Set(realPageNumbers) : null
  const calls = Array.isArray(observation?.toolCalls) ? observation!.toolCalls! : []
  const keypoints = Array.isArray(evalCase?.keyPoints) ? evalCase!.keyPoints! : []
  const budgetExhausted = observation?.budgetExhausted === true

  if (status !== 'completed') {
    reasons.push(`status 不是 completed（实际：${String(status)}）`)
  }

  if (facts.length === 0) {
    reasons.push('没有任何事实')
  }

  const groundedFacts: Array<{ text?: string; pageRefs?: number[] }> = []
  const ungroundedFacts: Array<{ text?: string; pageRefs?: number[] }> = []

  for (const fact of facts) {
    const refs = Array.isArray(fact.pageRefs) ? fact.pageRefs : []
    const ok = realPageSet !== null && refs.length > 0 && refs.every((p) => realPageSet.has(p))

    if (ok) groundedFacts.push(fact)
    else ungroundedFacts.push(fact)

    if (realPageNumbers === null) {
      reasons.push(`事实 "${fact.text ?? '<无正文>'}" 的页码无法判定（PDF 读不出来）`)
    } else if (!ok) {
      reasons.push(`事实 "${fact.text ?? '<无正文>'}" 的页码不在真实页集合里（${refs.join(', ')}）`)
    }
  }

  const factTexts = facts.map((f) => String(f?.text ?? '').toLowerCase())
  const missingChecklist: string[] = []

  for (const item of keypoints) {
    const keywords = Array.isArray(item?.keywords) ? item.keywords : []
    const hit = keywords.some((kw) => {
      const needle = String(kw ?? '').toLowerCase()
      return needle.length > 0 && factTexts.some((t) => t.includes(needle))
    })
    if (!hit) {
      missingChecklist.push(item?.id ?? '(未命名要点)')
    }
  }

  if (missingChecklist.length > 0) {
    reasons.push(`漏掉了要点：${missingChecklist.join(', ')}`)
  }

  const targetName = targetPdf(evalCase).name
  const selectedTarget = calls.some((c) => {
    return (
      c.capability === EXTRACT_PDF_CAPABILITY &&
      typeof c.arguments['path'] === 'string' &&
      basename(c.arguments['path']) === targetName
    )
  })

  if (!selectedTarget) {
    reasons.push(`没有提取目标 PDF（${String(targetName)}）`)
  }

  if (budgetExhausted) {
    reasons.push('出现过 budget_exhausted 事件')
  }

  const fullSuccess = reasons.length === 0

  return {
    fullSuccess,
    reasons,
    facts: facts.length,
    groundedFacts: groundedFacts.length,
    ungroundedFacts: ungroundedFacts.length,
    hitKeyPoints: keypoints
      .filter((item) => {
        const keywords = Array.isArray(item?.keywords) ? item.keywords : []
        return keywords.some((kw) => {
          const needle = String(kw ?? '').toLowerCase()
          return needle.length > 0 && factTexts.some((t) => t.includes(needle))
        })
      })
      .map((item) => item?.id ?? '(未命名要点)'),
    missedKeyPoints: missingChecklist,
    selectedTarget
  }
}
