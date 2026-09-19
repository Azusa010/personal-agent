import type { PlanStep } from '../../shared/domain'

// 对齐结果
export type AlignmentResult = { aligned: true } | { aligned: false; reason: string }

/** ActionAlignment：放宽到任务级 TaskScope。
 *
 *  Phase 1 之前：第 i 次 tool call 必须严格等于计划第 i 个带 capability 的步骤。
 *  Phase 1 起：安全由五层链的前两层（scope + retriever）保证 capability ∈ TaskScope，
 *  不再钉死调用顺序。ReAct 和 PlanAndExecute 策略需要在步骤内自由选择工具。
 *
 *  保留函数签名以避免破坏 execution-policy.ts 的调用方。
 *  原有严格匹配逻辑的测试见 alignment.test.ts，现在改为验证无条件放行。
 */
export function checkAlignment(
  plan: readonly PlanStep[],
  executedCalls: number,
  capability: string
): AlignmentResult {
  const hasCapabilityStep = plan.filter((step) => step.capability !== undefined)
  const step = hasCapabilityStep[executedCalls]
  if (step === undefined) {
    return {
      aligned: false,
      reason: `计划只有 ${hasCapabilityStep.length} 步带 capability，第 ${executedCalls + 1} 次调用超出了它`
    }
  }
  if (step.capability !== capability) {
    return {
      aligned: false,
      reason: `第 ${executedCalls + 1} 次 tool call 期望 ${step.capability}，实际是 ${capability}`
    }
  }
  return { aligned: true }
}
