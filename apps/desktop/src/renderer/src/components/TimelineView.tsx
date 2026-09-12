import type { TimelineIpcResult } from '../../../shared/ipc-contract'
import { STATUS_LABELS, describeEvent, formatOccurredAt } from '../view-model'

export interface TimelineViewProps {
  /** null = 这个会话里还没读过库 */
  result: TimelineIpcResult | null
  loading: boolean
  onReload: () => void
}

export function TimelineView({ result, loading, onReload }: TimelineViewProps): React.JSX.Element {
  // 先把 timeline 抽出来：下面要用四次，写成 result.timeline.task.status 这种链既难读也难窄化。
  const timeline = result !== null && result.ok ? result.timeline : null

  return (
    <section className="panel">
      <h2>时间线</h2>
      <div className="row">
        <button disabled={loading} onClick={onReload}>
          {loading ? '读取中…' : '重新读取'}
        </button>
        <span className="hint">读的是库里最近创建的任务。关掉应用再打开也读得到。</span>
      </div>

      {result === null && <p className="hint">还没读过库。跑一个任务，或点「重新读取」。</p>}

      {result !== null && !result.ok && (
        <p className="outcome outcome-error">
          [{result.code}] {result.message}
        </p>
      )}

      {result !== null && result.ok && timeline === null && (
        <p className="hint">库里还没有任务。</p>
      )}

      {timeline !== null && (
        <>
          <div className="task-head">
            <span className={`badge badge-${timeline.task.status}`}>
              {STATUS_LABELS[timeline.task.status]}
            </span>
            <span className="goal">{timeline.task.goal}</span>
          </div>
          <div className="hint">
            id {timeline.task.id} · 建于 {formatOccurredAt(timeline.task.createdAt)} · 更新于{' '}
            {formatOccurredAt(timeline.task.updatedAt)}
          </div>

          {timeline.events.length === 0 ? (
            <p className="hint">这个任务还没有事件。</p>
          ) : (
            <ol className="timeline">
              {timeline.events.map((event) => {
                const line = describeEvent(event)
                return (
                  <li key={line.seq} className={`ev ev-${line.type}`}>
                    <span className="seq">{line.seq}</span>
                    <span className="label">{line.label}</span>
                    <span className="summary">{line.summary}</span>
                    <span className="time">{line.time}</span>
                  </li>
                )
              })}
            </ol>
          )}
        </>
      )}
    </section>
  )
}
