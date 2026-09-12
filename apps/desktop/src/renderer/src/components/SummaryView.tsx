import type { SummaryFact } from '../../../shared/ipc-contract'

export interface SummaryViewProps {
  /** 摘要正文。优先是库里还原出来的，还原不出来才是本次 IPC 的返回值 */
  facts: SummaryFact[]
  /** 库里 task_completed 记的条数。null = 这个任务没跑完过 */
  persistedCount: number | null
}

export function SummaryView({ facts, persistedCount }: SummaryViewProps): React.JSX.Element {
  const factsLost = facts.length === 0 && persistedCount !== null && persistedCount > 0

  return (
    <section className="panel">
      <h2>摘要</h2>

      {facts.length > 0 && (
        <ul className="facts">
          {facts.map((fact, i) => (
            <li key={i}>
              <span>{fact.text}</span>
              <span className="refs">
                {fact.pageRefs.length > 0 ? `第 ${fact.pageRefs.join('、')} 页` : '无页码引用'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {factsLost && (
        <p className="hint">
          库里记着这个任务产出了 {persistedCount} 条摘要，但正文读不出来 —— 这条 task_completed 是在
          payload 带上 facts 之前写下的，那时候只存了 factCount。
        </p>
      )}

      {facts.length === 0 && !factsLost && (
        <p className="hint">还没有摘要。跑一个任务，完成时这里会出现带页码引用的条目。</p>
      )}
    </section>
  )
}
