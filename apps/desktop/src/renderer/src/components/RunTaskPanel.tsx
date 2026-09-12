import { useState } from 'react'
import type { RunOutcomeView } from '../view-model'

export interface RunTaskPanelProps {
  /** 任务在跑的时候按钮要禁掉：runTask 是阻塞的，连点会建出多个 Task */
  running: boolean
  /** null 表示这个会话里还没跑过任务 */
  outcome: RunOutcomeView | null
  onRun: (goal: string) => void
}

export function RunTaskPanel({ running, outcome, onRun }: RunTaskPanelProps): React.JSX.Element {
  const [goal, setGoal] = useState('')
  const trimmed = goal.trim()

  return (
    <section className="panel">
      <h2>跑一个任务</h2>
      <p className="hint">
        Phase 1 的流程是固定的三步（列 PDF → 提文本 → 生成摘要），不会按你写的目标改。目标只会被
        写进 Task 和第一条事件。
      </p>

      <div className="row">
        <input
          type="text"
          value={goal}
          placeholder="比如：整理 Downloads 里的 PDF"
          onChange={(e) => setGoal(e.target.value)}
        />
        <button disabled={running || trimmed.length === 0} onClick={() => onRun(trimmed)}>
          {running ? '执行中…' : '跑任务'}
        </button>
      </div>

      {outcome !== null && (
        <div className={`outcome outcome-${outcome.tone}`}>
          <div className="headline">{outcome.headline}</div>
          {outcome.detail !== null && <div className="detail">{outcome.detail}</div>}
          {outcome.taskId !== null && <div className="detail">taskId {outcome.taskId}</div>}
        </div>
      )}
    </section>
  )
}
