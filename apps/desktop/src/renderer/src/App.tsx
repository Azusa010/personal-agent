import { useCallback, useEffect, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import type {
  MessageView,
  PermissionDecision,
  PermissionRecord,
  PermissionRespondResult,
  SendMessageIpcResult,
  RuntimeStatus
} from '../../shared/ipc-contract'
import { Composer } from './components/Composer'
import { DiagnosticsDialog } from './components/DiagnosticsDialog'
import { IndexDialog } from './components/IndexDialog'
import { MessageStream } from './components/MessageStream'
import { PermissionDialog } from './components/PermissionDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { WorkflowCenter } from './components/WorkflowCenter'
import {
  applyStreamNotice,
  createInitialStreamState,
  formatOccurredAt,
  type LiveStreamState,
  timelineToMarkdown
} from './view-model'
import { useQuery, useQueryClient } from '@tanstack/react-query'

function App(): React.JSX.Element {
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      const result = await window.personalAgent.listConversations()
      return result.ok ? result.conversations : []
    }
  })
  const { data: agentProfile } = useQuery({
    queryKey: ['agentProfile'],
    queryFn: async () => {
      const result = await window.personalAgent.getAgentProfile()
      return result.ok ? result.profile : null
    }
  })
  const [activeView, setActiveView] = useState<'chat' | 'workflows'>('chat')
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageView[]>([])
  const [messagesError, setMessagesError] = useState<string | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [streamState, setStreamState] = useState<LiveStreamState | null>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null)
  const [indexedCount, setIndexedCount] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [indexOpen, setIndexOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 自增即重开一轮 runtime 状态轮询：设置保存后 runtime 会重启，
  // 不重新拉的话状态栏会停在旧值。
  const [statusPollKey, setStatusPollKey] = useState(0)
  const [pendingPermission, setPendingPermission] = useState<PermissionRecord | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const feedbackTimer = useRef<number | null>(null)

  const showFeedback = (text: string): void => {
    setFeedback(text)
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 2600)
  }

  const loadConversation = useCallback(async (conversationId: string): Promise<void> => {
    setMessagesError(null)
    try {
      const result = await window.personalAgent.getConversation(conversationId)
      if (result.ok) setMessages(result.messages)
      else {
        setMessages([])
        setMessagesError(`[${result.code}] ${result.message}`)
      }
    } catch (err) {
      setMessages([])
      setMessagesError(err instanceof Error ? err.message : String(err))
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

  // Runtime 状态轮询：starting 期间每秒问一次，到终态停表（TASK-029 的老坑）。
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

  useEffect(() => {
    const unsubscribe = window.personalAgent.onPermissionNotice((notice) => {
      if (notice.kind === 'requested') {
        setPendingPermission(notice.permission)
        return
      }
      setPendingPermission((current) =>
        current !== null && current.id === notice.permissionId ? null : current
      )
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.personalAgent.onAgentStream((notice) => {
      setStreamState((current) => applyStreamNotice(current, notice))
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
      showFeedback(`批准提交失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.ok) {
      showFeedback(`[${result.code}] ${result.message}`)
      return
    }
    setPendingPermission(null)
    showFeedback(
      (decision === 'approved' ? '已批准' : '已拒绝') +
        (result.repeated
          ? '（这条早就有同样的结论，本次点击没产生新副作用）'
          : ` ${target.capability}`)
    )
  }

  const handleSelectConversation = (conversationId: string): void => {
    setActiveView('chat')
    setSelectedConversationId(conversationId)
    void loadConversation(conversationId)
  }

  const handleNewChat = (): void => {
    setActiveView('chat')
    setSelectedConversationId(null)
    setMessages([])
    setMessagesError(null)
    inputRef.current?.focus()
  }

  const queryClient = useQueryClient()
  const handleSend = async (text: string): Promise<void> => {
    setRunning(true)
    setPendingText(text)
    setStreamState(createInitialStreamState())
    let result: SendMessageIpcResult
    try {
      result = await window.personalAgent.sendMessage({
        conversationId: selectedConversationId,
        text
      })
    } catch (err) {
      // 正常不会进这里：sendMessage 的契约是永不抛。真抛了说明 preload / IPC 层坏了。
      result = {
        ok: false,
        code: 'RUNTIME_CRASHED',
        message: err instanceof Error ? err.message : String(err),
        conversationId: selectedConversationId ?? ''
      }
    } finally {
      setRunning(false)
      setPendingText(null)
      setStreamState(null)
    }
    queryClient.invalidateQueries({ queryKey: ['conversations'] })
    // 不管这轮成没成，会话里都留下了痕迹（user 消息 + 承载结局的 assistant 消息），重读它。
    setSelectedConversationId(result.conversationId)
    if (result.conversationId !== '') await loadConversation(result.conversationId)
    if (result.ok && result.status === 'completed') showFeedback('本轮完成。')
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
    const lastTimeline = [...messages].reverse().find((m) => m.timeline !== null)?.timeline ?? null
    if (lastTimeline === null) {
      showFeedback('当前没有可导出的任务。')
      return
    }
    try {
      await navigator.clipboard.writeText(timelineToMarkdown(lastTimeline))
      showFeedback('已复制为 Markdown，可粘贴保存。')
    } catch {
      showFeedback('复制失败：剪贴板不可用。')
    }
  }

  const selected = conversations.find((c) => c.id === selectedConversationId) ?? null
  // 诊断面板与导出都跟着「最近一次执行」走：一段会话可能有多轮任务。
  const lastTaskId = [...messages].reverse().find((m) => m.taskId !== null)?.taskId ?? null

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        runtimeStatus={runtimeStatus}
        indexedCount={indexedCount}
        activeView={activeView}
        onSelectView={setActiveView}
        onSelectConversation={handleSelectConversation}
        onNewChat={handleNewChat}
        onOpenIndex={() => setIndexOpen(true)}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />

      {activeView === 'chat' ? (
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[70px] shrink-0 items-center justify-between border-b border-border px-6">
            <div className="min-w-0">
              <h2 className="m-0 truncate text-[15px] font-semibold">
                {selected === null ? '新对话' : selected.title}
              </h2>
              <p className="m-0 mt-1 truncate text-[11px] text-muted-foreground">
                {selected === null
                  ? '本地优先的个人助理'
                  : `最近活动 ${formatOccurredAt(selected.updatedAt)}`}
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
            messages={messages}
            pendingText={pendingText}
            messagesError={messagesError}
            feedback={feedback}
            streamState={streamState}
            agentName={agentProfile?.name}
          />

          <Composer
            running={running}
            inputRef={inputRef}
            onSend={(text) => void handleSend(text)}
            onScan={() => void handleScan()}
            onOpenIndex={() => setIndexOpen(true)}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
            onExport={() => void handleExport()}
          />
        </section>
      ) : (
        <WorkflowCenter onCompleted={() => void loadIndexedCount()} />
      )}

      <IndexDialog open={indexOpen} onOpenChange={setIndexOpen} />
      <DiagnosticsDialog
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        taskId={lastTaskId}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => {
          setStatusPollKey((key) => key + 1)
          void queryClient.invalidateQueries({ queryKey: ['agentProfile'] })
        }}
      />
      <PermissionDialog permission={pendingPermission} onDecide={handleDecide} />
    </div>
  )
}

export default App
