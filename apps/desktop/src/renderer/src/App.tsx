import { useCallback, useEffect, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import type {
  PermissionDecision,
  PermissionRecord,
  PermissionRespondResult,
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
import { PermissionDialog } from './components/PermissionDialog'
import { SettingsDialog } from './components/SettingsDialog'
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 自增即重开一轮 runtime 状态轮询：设置保存后 runtime 会重启，
  // 首轮轮询早就在终态停表了，不重新拉的话状态栏会停在旧值。
  const [statusPollKey, setStatusPollKey] = useState(0)
  const [pendingPermission, setPendingPermission] = useState<PermissionRecord | null>(null)
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
  }, [])

  // Runtime 状态不是一次性的：Main 侧从 starting 走到 ready/crashed 是异步的
  // （打包版要先把冻结产物拉起来），挂载时读一次的话状态栏会永远停在「启动中」。
  // 在 starting 期间每秒再问一次，到终态就停表；statusPollKey 自增（设置保存后
  // runtime 被重启）会重新拉起一轮。
  useEffect(() => {
    let timer: number | null = null
    const poll = async (): Promise<void> => {
      const status = await window.personalAgent.runtimeStatus()
      setRuntimeStatus(status)
      if (status.state === 'starting') {
        timer = window.setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [statusPollKey])

  // 批准通道的推送订阅。这是全应用唯一一个 main → renderer 的事件流。
  useEffect(() => {
    const unsubscribe = window.personalAgent.onPermissionNotice((notice) => {
      if (notice.kind === 'requested') {
        setPendingPermission(notice.permission)
        return
      }
      // resolved 有两种成因：用户自己刚点了（respond 已本地关面板），或主进程判定过期。
      // 用函数式更新比对 id：直接读 pendingPermission 会拿到订阅那一刻的闭包旧值。
      setPendingPermission((current) =>
        current !== null && current.id === notice.permissionId ? null : current
      )
    })
    return unsubscribe
  }, [])

  const handleDecide = async (decision: PermissionDecision): Promise<void> => {
    const target = pendingPermission
    if (target === null) return
    let result: PermissionRespondResult
    try {
      result = await window.personalAgent.respondPermission(target.id, decision)
    } catch (err) {
      // 正常不会进这里：respondPermission 的契约是永不抛。真抛了说明 preload / IPC 层坏了。
      showFeedback(`批准提交失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.ok) {
      // 失败不关面板：让用户看见原因。过期场景由随后的 resolved 推送关掉。
      showFeedback(`[${result.code}] ${result.message}`)
      return
    }
    setPendingPermission(null)
    const verb = decision === 'approved' ? '已批准' : '已拒绝'
    showFeedback(
      result.repeated
        ? `${verb}（这条早就有同样的结论，本次点击没产生新副作用）`
        : `${verb} ${target.capability}`
    )
  }

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
        onSettings={() => setSettingsOpen(true)}
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
      <DiagnosticsDialog
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        taskId={selectedTaskId}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => setStatusPollKey((key) => key + 1)}
      />
      <PermissionDialog permission={pendingPermission} onDecide={handleDecide} />
    </div>
  )
}

export default App
