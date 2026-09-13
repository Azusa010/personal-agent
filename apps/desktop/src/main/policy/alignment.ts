import type { PlanStep } from '../../shared/domain'

// 对齐结果
export type AlignmentResult = { aligned: true } | { aligned: false; reason: string }

/** ActionAlignment：第 i 次真正执行的 tool call，能力必须等于计划里第 i 个带
 *  capability 的步骤。
 *
 * 入参（三个都由 execution-policy.ts 从 task-context.ts 的 ActiveTask 里取，
 * 而 ActiveTask 是 run-task.ts 在发 agent.run_task 之前 beginTask 写进去的）：
 *
 * - plan：agent.make_plan 回包的 steps 原样。Phase 2 的字面值就是
 *     [{ description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
 *      { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
 *      { description: '基于页面内容生成带页码引用的摘要' }]
 *
 * - executedCalls：这个任务里已经**放行**过多少次 tool call。第一次调用时是 0，
 *   放行一次由策略加一（recordExecutedCall）。被拒绝的调用不加，所以模型调错了
 *   再改对，仍然对得上同一个序号。
 *
 * - capability：这一次要调的能力名，来自 HostExecuteToolParams.capability，
 *   字面值是 'filesystem.list' 或 'document.extract_pdf'（CapabilityId 枚举里的六个之一）。
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
