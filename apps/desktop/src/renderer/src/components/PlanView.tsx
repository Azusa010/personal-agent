import type { PlanRecord } from '../../../shared/ipc-contract'
import { describePlanSteps, formatOccurredAt } from '../view-model'

export interface PlanViewProps {
  /** null = 库里这个任务没有计划 */
  plan: PlanRecord | null
}

export function PlanView({ plan }: PlanViewProps): React.JSX.Element {
  const steps = describePlanSteps(plan)

  return (
    <section className="panel">
      <h2>计划</h2>
      <p className="hint">
        Phase 1 的计划是固定三步，不随你写的目标变化 —— 这是产品钉死的流程，
        不是模型为你的目标规划出来的步骤。
      </p>

      {plan === null && <p className="hint">这个任务没有计划。</p>}

      {plan !== null && (
        <>
          <div className="hint">
            版本 v{plan.version} · 建于 {formatOccurredAt(plan.createdAt)}
          </div>
          {steps.length === 0 ? (
            <p className="hint">计划里没有步骤。</p>
          ) : (
            <ol className="plan">
              {steps.map((step) => (
                <li key={step.index}>
                  <span className="seq">{step.index}</span>
                  <span className="label">{step.description}</span>
                  <span className="capability">{step.capabilityLabel}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  )
}
