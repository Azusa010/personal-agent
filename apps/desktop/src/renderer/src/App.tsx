import { useCallback, useEffect, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import type {
  RunTaskIpcResult,
  RuntimeStatus,
  TaskRecord,
  TaskTimeline,
  TimelineIpcResult
} from '../../shared/ipc-contract'
import { Composer } from './components/Composer'
import { DiagnosticsDialog } from './components/DiagnosticsDialog'
import { IndexDialog } from './components/IndexDialog'
import { MessageStream } from './components/MessageStream'
import { Sidebar } from './components/Sidebar'
import { formatOccurredAt, STATUS_LABELS, timelineToMarkdown } from './view-model'

function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TaskTimeline | null>(null)
  const [timelineError, setTimelineError] = useState<string | null>(null)
  const [pendingGoal, setPendingGoal] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null)
  const [indexedCount, setIndexedCount] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [indexOpen, setIndexOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const feedbackTimer = useRef<number | null>(null)

  const showFeedback = (text: string): void => {
    setFeedback(text)
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 2600)
  }

  const loadTasks = useCallback(async (): Promise<void> => {
    try {
      const result = await window.personalAgent.listTasks()
      if (result.ok) setTasks(result.tasks)
    } catch (err) {
      console.error('[renderer] 读任务列表失败', err)
    }
  }, [])

  const loadTimeline = useCallback(async (taskId: string | null): Promise<void> => {
    setTimelineError(null)
    let result: TimelineIpcResult
    try {
      result = await window.personalAgent.getTimeline(taskId)
    } catch (err) {
      setTimeline(null)
      setTimelineError(err instanceof Error ? err.message : String(err))
      return
    }
    if (result.ok) setTimeline(result.timeline)
    else {
      setTimeline(null)
      setTimelineError(`[${result.code}] ${result.message}`)
    }
  }, [])

  const loadIndexedCount = useCallback(async (): Promise<void> => {
    try {
      const result = await window.personalAgent.indexedPdfs()
      if (result.ok) setIndexedCount(result.entries.length)
    } catch (err) {
      console.error('[renderer] 读索引数量失败', err)
    }
  }, [])

  useEffect(() => {
    void window.personalAgent
      .listTasks()
      .then((result) => {
        if (result.ok) setTasks(result.tasks)
      })
      .catch((err) => console.error('[renderer] 读任务列表失败', err))
    void window.personalAgent
      .indexedPdfs()
      .then((result) => {
        if (result.ok) setIndexedCount(result.entries.length)
      })
      .catch((err) => console.error('[renderer] 读索引数量失败', err))
    void window.personalAgent.runtimeStatus().then(setRuntimeStatus)
  }, [])

  const handleSelectTask = (taskId: string): void => {
    setSelectedTaskId(taskId)
    void loadTimeline(taskId)
  }

  const handleNewChat = (): void => {
    setSelectedTaskId(null)
    setTimeline(null)
    setTimelineError(null)
    inputRef.current?.focus()
  }

  const handleSend = async (goal: string): Promise<void> => {
    setRunning(true)
    setPendingGoal(goal)
    setSelectedTaskId(null)
    setTimeline(null)
    setTimelineError(null)
    let result: RunTaskIpcResult
    try {
      result = await window.personalAgent.runTask(goal)
    } catch (err) {
      // 正常不会进这里：runTask 的契约是永不抛。真抛了说明 preload / IPC 层坏了。
      result = {
        ok: false,
        code: 'RUNTIME_CRASHED',
        message: err instanceof Error ? err.message : String(err)
      }
    }
    setRunning(false)
    setPendingGoal(null)
    await loadTasks()
    if (result.ok) {
      setSelectedTaskId(result.taskId)
      await loadTimeline(result.taskId)
      showFeedback(
        result.status === 'completed'
          ? '任务完成，回答仅基于本地文件。'
          : `任务结束：${result.status}`
      )
    } else {
      setTimelineError(`[${result.code}] ${result.message}`)
    }
    void loadIndexedCount()
  }

  const handleScan = async (): Promise<void> => {
    showFeedback('正在扫描 Downloads 里的 PDF…')
    try {
      const result = await window.personalAgent.listPdfs('downloads')
      if (result.ok) {
        showFeedback(`扫描完成，共索引 ${result.entries.length} 份 PDF。`)
        void loadIndexedCount()
      } else {
        showFeedback(`扫描失败（${result.code}）：${result.message}`)
      }
    } catch (err) {
      showFeedback(`扫描失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleExport = async (): Promise<void> => {
    if (timeline === null) {
      showFeedback('当前没有可导出的会话。')
      return
    }
    try {
      await navigator.clipboard.writeText(timelineToMarkdown(timeline))
      showFeedback('已复制为 Markdown，可粘贴保存。')
    } catch {
      showFeedback('复制失败：剪贴板不可用。')
    }
  }

  const selected = tasks.find((task) => task.id === selectedTaskId) ?? null

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        runtimeStatus={runtimeStatus}
        indexedCount={indexedCount}
        onSelectTask={handleSelectTask}
        onNewChat={handleNewChat}
        onOpenIndex={() => setIndexOpen(true)}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        onSettings={() => showFeedback('设置面板暂未实现。')}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[70px] shrink-0 items-center justify-between border-b border-border px-6">
          <div className="min-w-0">
            <h2 className="m-0 truncate text-[15px] font-semibold">
              {selected === null ? '新对话' : selected.goal}
            </h2>
            <p className="m-0 mt-1 truncate text-[11px] text-muted-foreground">
              {selected === null
                ? '尚未引用本地文件'
                : `${STATUS_LABELS[selected.status]} · ${formatOccurredAt(selected.createdAt)}`}
            </p>
          </div>
          <button
            type="button"
            aria-label="更多操作"
            onClick={() => showFeedback('更多会话操作暂未实现。')}
            className="rounded-md p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Ellipsis size={18} />
          </button>
        </header>

        <MessageStream
          timeline={timeline}
          pendingGoal={pendingGoal}
          timelineError={timelineError}
          feedback={feedback}
        />

        <Composer
          running={running}
          inputRef={inputRef}
          onSend={(goal) => void handleSend(goal)}
          onScan={() => void handleScan()}
          onOpenIndex={() => setIndexOpen(true)}
          onOpenDiagnostics={() => setDiagnosticsOpen(true)}
          onExport={() => void handleExport()}
        />
      </section>

      <IndexDialog open={indexOpen} onOpenChange={setIndexOpen} />
      <DiagnosticsDialog open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} />
    </div>
  )
}

export default App
