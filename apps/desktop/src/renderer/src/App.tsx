import { useState } from 'react'
import type {
  ListPdfsResult,
  IndexedPdfsResult,
  RunTaskIpcResult,
  TimelineIpcResult
} from '../../shared/ipc-contract'
import {
  describeRunOutcome,
  extractFactCount,
  extractFacts,
  type RunOutcomeView
} from './view-model'
import { RunTaskPanel } from './components/RunTaskPanel'
import { PlanView } from './components/PlanView'
import { TimelineView } from './components/TimelineView'
import { SummaryView } from './components/SummaryView'

function App(): React.JSX.Element {
  const [status, setStatus] = useState('Empty')
  const ipcHandle = async (): Promise<void> => {
    const response = await window.personalAgent.runtimeStatus()
    setStatus(JSON.stringify(response, null, 2))
  }

  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfResult, setPdfResult] = useState<ListPdfsResult | null>(null)
  const [dbResult, setDbResult] = useState<IndexedPdfsResult | null>(null)
  const handleListPdfs = async (): Promise<void> => {
    setPdfLoading(true)
    setPdfResult(null)
    try {
      setPdfResult(await window.personalAgent.listPdfs('downloads'))
    } catch (err) {
      setPdfResult({
        ok: false,
        code: 'RUNTIME_CRASHED',
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setPdfLoading(false)
    }
  }

  const handleReadDb = async (): Promise<void> => {
    setDbResult(await window.personalAgent.indexedPdfs())
  }

  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<RunOutcomeView | null>(null)
  const [timelineResult, setTimelineResult] = useState<TimelineIpcResult | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)

  // taskId 传 null 就是「读最近创建的那个」。手动刷新走这一支，
  // 因为重启之后 state 里的 taskId 已经没了。
  const loadTimeline = async (taskId: string | null): Promise<void> => {
    setTimelineLoading(true)
    try {
      setTimelineResult(await window.personalAgent.getTimeline(taskId))
    } catch (err) {
      setTimelineResult({
        ok: false,
        code: 'RUNTIME_CRASHED',
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setTimelineLoading(false)
    }
  }

  const handleRunTask = async (goal: string): Promise<void> => {
    setRunning(true)
    setOutcome(null)
    let result: RunTaskIpcResult
    try {
      result = await window.personalAgent.runTask(goal)
    } catch (err) {
      // 正常不会进这里：runTask 的契约是永不抛。真抛了说明是 preload / IPC 层坏了，
      // 那也要给用户一句话，而不是让 promise 静默 reject。
      result = {
        ok: false,
        code: 'RUNTIME_CRASHED',
        message: err instanceof Error ? err.message : String(err)
      }
    } finally {
      setRunning(false)
    }
    setOutcome(describeRunOutcome(result))
    // 跑完自动读一次：Phase 1 没有流式，事件是任务结束时一次性落库的，这一次就是全部。
    await loadTimeline(result.ok ? result.taskId : null)
  }

  const timeline = timelineResult !== null && timelineResult.ok ? timelineResult.timeline : null
  const persistedFactCount = timeline === null ? null : extractFactCount(timeline.events)
  // 库是事实来源。只有从库里一条也还原不出来时才退回本次 IPC 的返回值，
  // 那一支盖的是事件写库失败、但任务确实跑完了的情况。
  const persistedFacts = timeline === null ? [] : extractFacts(timeline.events)
  const facts = persistedFacts.length > 0 ? persistedFacts : (outcome?.facts ?? [])

  return (
    <>
      <div>
        <h1>Personal Agent</h1>
        <button onClick={ipcHandle}>Send IPC</button>
        <div id="response">{status}</div>
        <h2>PDF 列表</h2>
        <button onClick={handleListPdfs} disabled={pdfLoading}>
          {pdfLoading ? '加载中…' : '列出 PDF'}
        </button>

        {pdfResult !== null && !pdfResult.ok && (
          <p>
            [{pdfResult.code}] {pdfResult.message}
          </p>
        )}

        {pdfResult !== null && pdfResult.ok && pdfResult.entries.length === 0 && (
          <p>~/Downloads 里没有 PDF</p>
        )}

        {pdfResult !== null && pdfResult.ok && pdfResult.entries.length > 0 && (
          <ul>
            {pdfResult.entries.map((entry) => (
              <li key={entry.absolutePath}>
                <div>{entry.name}</div>
                <div>
                  {entry.modifiedAt} · {Math.round(entry.sizeBytes / 1024)} KB
                </div>
              </li>
            ))}
          </ul>
        )}
        <h2>库里的索引</h2>
        <button onClick={handleReadDb}>从库读</button>

        {dbResult !== null && !dbResult.ok && (
          <p>
            [{dbResult.code}] {dbResult.message}
          </p>
        )}

        {dbResult !== null && dbResult.ok && (
          <p>共 {dbResult.entries.length} 条（先点上面「列出 PDF」才会有数据）</p>
        )}

        {dbResult !== null && dbResult.ok && (
          <ul>
            {dbResult.entries.map((row) => (
              <li key={row.absolutePath}>
                <div>{row.name}</div>
                <div>
                  首次入库 {row.firstSeenAt} · 最近见到 {row.lastSeenAt}
                </div>
              </li>
            ))}
          </ul>
        )}

        <RunTaskPanel running={running} outcome={outcome} onRun={handleRunTask} />

        <PlanView plan={timeline?.plan ?? null} />

        <TimelineView
          result={timelineResult}
          loading={timelineLoading}
          onReload={() => void loadTimeline(null)}
        />

        <SummaryView facts={facts} persistedCount={persistedFactCount} />
      </div>
    </>
  )
}

export default App
