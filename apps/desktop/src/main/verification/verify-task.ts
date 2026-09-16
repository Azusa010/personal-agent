import type { SummaryFact } from '@personal-agent/protocol'

import {
  collectEvidence,
  type EvidenceBundle,
  type EvidenceDeps,
  type VerificationReport
} from './evidence-bundle'
import { verifyDeliverables } from './verify-deliverables'

/**
 * 完成校验的编排：取证 → 判定 → 交出可留档的 Evidence Bundle。
 *
 * 只有两行逻辑，故意如此：run-task 需要一个可注入的闸口（CompletionVerifier），
 * 而闸口的两个动作分别属于 evidence-bundle.ts（事实）与 verify-deliverables.ts（规则）。
 * 接线放这里，测试注入假端口就能整条跑通，不必碰真文件。
 */

export interface VerificationInput {
  taskId: string
  /** Python 的完成声明。取证侧只当声明看 */
  facts: SummaryFact[]
}

export interface VerificationOutcome {
  report: VerificationReport
  /** 留档产物（带报告）。校验器自身异常时为 null —— 那时连证据都没取到 */
  evidence: EvidenceBundle | null
}

/** run-task 依赖的窄端口。生产实现见 index.ts 的接线，测试注入假件。 */
export type CompletionVerifier = (input: VerificationInput) => Promise<VerificationOutcome>

export type VerificationDeps = EvidenceDeps

export async function verifyTaskCompletion(
  deps: VerificationDeps,
  input: VerificationInput
): Promise<VerificationOutcome> {
  const collected = await collectEvidence(deps, input)
  const report = verifyDeliverables(collected)
  return { report, evidence: { ...collected, verificationReport: report } }
}
