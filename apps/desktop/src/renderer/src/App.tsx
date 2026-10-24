import { WelcomeView } from './components/WelcomeView'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Ellipsis, Share2 } from 'lucide-react'
import type {
  MessageView,
  PermissionDecision,
  PermissionRecord,
  PermissionRespondResult,
  SendMessageIpcResult,
  RuntimeStatus,
  A2UIRenderNotice,
  BotView,
  WorkspaceView
} from '../../shared/ipc-contract'
import { A2UIInlineCard } from './components/a2ui'
import { BotDialog } from './components/BotDialog'
import { Composer } from './components/Composer'
import { DiagnosticsDialog } from './components/DiagnosticsDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { IndexDialog } from './components/IndexDialog'
import { MessageStream } from './components/MessageStream'
import { PermissionCard } from './components/PermissionCard'
import { SettingsPage } from './components/SettingsPage'
import { Sidebar, type AppView } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { WorkflowCenter } from './components/WorkflowCenter'
import {
  applyStreamNotice,
  createInitialStreamState,
  type LiveStreamState,
  timelineToMarkdown
} from './view-model'
import { applyThemeToRoot } from './lib/theme'
import { useQuery, useQueryClient } from '@tanstack/react-query'

function App(): React.JSX.Element {
  const queryClient = useQueryClient()

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      const result = await window.personalAgent.listConversations()
      return result.ok ? result.conversations : []
    }
  })

  const { data: bots = [] } = useQuery({
    queryKey: ['bots'],
    queryFn: async () => {
      const result = await window.personalAgent.listBots()
      return result.ok ? result.bots : []
    }
  })

  const { data: agentProfile } = useQuery({
    queryKey: ['agentProfile'],
    queryFn: async () => {
      const result = await window.personalAgent.getAgentProfile()
      return result.ok ? result.profile : null
    }
  })

  const [activeView, setActiveView] = useState<AppView>('chat')
  const [activeBotId, setActiveBotId] = useState<string | null>(null)
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageView[]>([])
  const [messagesError, setMessagesError] = useState<string | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [streamState, setStreamState] = useState<LiveStreamState | null>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null)
  const [indexedCount, setIndexedCount] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null)
  const [indexOpen, setIndexOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [botDialogOpen, setBotDialogOpen] = useState(false)
  const [editingBot, setEditingBot] = useState<BotView | null>(null)

  // 自增即重开一轮 runtime 状态轮询：设置保存后 runtime 会重启，
  // 不重新拉的话状态栏会停在旧值。
  const [statusPollKey, setStatusPollKey] = useState(0)
  const [pendingPermission, setPendingPermission] = useState<PermissionRecord | null>(null)
  const [activeA2UIRender, setActiveA2UIRender] = useState<A2UIRenderNotice | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const feedbackTimer = useRef<number | null>(null)

  const defaultBot = bots.find((b) => b.isDefault) ?? bots[0] ?? null
  const activeBot = (activeBotId ? bots.find((b) => b.id === activeBotId) : null) ?? defaultBot

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

  // 初始挂载时自动附着到默认智能体伴侣的常驻会话
  const initialBotAttached = useRef(false)
  useEffect(() => {
    if (!initialBotAttached.current && activeBot?.conversationId) {
      initialBotAttached.current = true
      setSelectedConversationId(activeBot.conversationId)
      void loadConversation(activeBot.conversationId)
    }
  }, [activeBot?.conversationId, loadConversation])

  const loadIndexedCount = useCallback(async (): Promise<void> => {
    try {
      const result = await window.personalAgent.indexedPdfs()
      if (result.ok) setIndexedCount(result.entries.length)
    } catch (err) {
      console.error('[renderer] 读索引数量失败', err)
    }
  }, [])

  const loadWorkspace = useCallback(async (): Promise<void> => {
    try {
      setWorkspace(await window.personalAgent.getWorkspace())
    } catch (err) {
      console.error('[renderer] 读工作区失败', err)
    }
  }, [])

  const applyWorkspaceResult = useCallback(
    (label: string, result: { ok: boolean; message?: string; changed?: boolean }): void => {
      if (result.ok) {
        void loadWorkspace()
        if (result.changed !== false) showFeedback(`${label}完成。`)
      } else {
        showFeedback(result.message ?? `${label}失败。`)
      }
    },
    [loadWorkspace, showFeedback]
  )

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

  const [thinkingByTaskId, setThinkingByTaskId] = useState<Record<string, string>>({})

  useEffect(() => {
    const unsubscribe = window.personalAgent.onAgentStream((notice) => {
      setStreamState((current) => applyStreamNotice(current, notice))
      if (notice.kind === 'thinking') {
        setThinkingByTaskId((prev) => ({
          ...prev,
          [notice.taskId]: (prev[notice.taskId] ?? '') + notice.delta
        }))
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.personalAgent.onA2UIRender((notice) => {
      setActiveA2UIRender(notice)
    })
    return unsubscribe
  }, [])

  // 工作区视图首载
  useEffect(() => {
    let cancelled = false
    void window.personalAgent
      .getWorkspace()
      .then((view) => {
        if (!cancelled) setWorkspace(view)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 主题的唯一驱动方是主进程：用户切换与「跟随系统」时的 OS 变化都从这里下发。
  // renderer 只负责把 effective 值落到 <html>，不自己算、也不自己存。
  useEffect(() => {
    const unsubscribe = window.personalAgent.onAppearanceChanged((appearance) => {
      applyThemeToRoot(document.documentElement, appearance.effective)
    })
    return unsubscribe
  }, [])

  const handleA2UISubmit = async (
    renderId: string,
    actionId: string,
    formData: Record<string, unknown>
  ): Promise<void> => {
    try {
      await window.personalAgent.submitA2UIForm({ renderId, actionId, formData })
      setActiveA2UIRender(null)
      if (selectedConversationId) {
        void loadConversation(selectedConversationId)
      }
    } catch (err) {
      showFeedback(`A2UI 表单提交失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

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

  const handleSelectBot = (bot: BotView): void => {
    setActiveBotId(bot.id)
    setActiveView('chat')
    setSelectedConversationId(bot.conversationId)
    void loadConversation(bot.conversationId)
  }

  const handleCreateBot = (): void => {
    setEditingBot(null)
    setBotDialogOpen(true)
  }

  const handleEditBot = (bot: BotView): void => {
    setEditingBot(bot)
    setBotDialogOpen(true)
  }

  const handleBotSaved = (savedBot: BotView): void => {
    void queryClient.invalidateQueries({ queryKey: ['bots'] })
    setActiveBotId(savedBot.id)
    setSelectedConversationId(savedBot.conversationId)
    void loadConversation(savedBot.conversationId)
    showFeedback(editingBot ? `已更新伴侣设定：${savedBot.name}` : `已创建伴侣：${savedBot.name}`)
  }

  const handleNewChat = (): void => {
    setActiveView('chat')
    setSelectedConversationId(null)
    setMessages([])
    setMessagesError(null)
    inputRef.current?.focus()
  }

  const handleSend = async (text: string): Promise<void> => {
    setRunning(true)
    setPendingText(text)
    setStreamState(createInitialStreamState())
    let result: SendMessageIpcResult
    try {
      result = await window.personalAgent.sendMessage({
        conversationId: selectedConversationId,
        text,
        botId: activeBot?.id ?? null
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
    void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    // 不管这轮成没成，会话里都留下了痕迹（user 消息 + 承载结局的 assistant 消息），重读它。
    setSelectedConversationId(result.conversationId)
    if (result.conversationId !== '') await loadConversation(result.conversationId)
    void loadIndexedCount()
  }

  const handleScan = async (): Promise<void> => {
    showFeedback('正在扫描工作区里的 PDF…')
    try {
      const result = await window.personalAgent.listPdfs('workspace')
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
  // 新对话：消息轨道空着时，hero 与输入区合成一列居中，而不是 hero 浮在中间、输入框吊在底部
  const showWelcome =
    messages.length === 0 && !pendingText && messagesError === null && pendingPermission === null
  // 诊断面板与导出都跟着「最近一次执行」走：一段会话可能有多轮任务。
  const lastTaskId = [...messages].reverse().find((m) => m.taskId !== null)?.taskId ?? null

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {activeView !== 'settings' && (
            <Sidebar
              selectedConversationId={selectedConversationId}
              runtimeStatus={runtimeStatus}
              indexedCount={indexedCount}
              activeView={activeView}
              bots={bots}
              activeBotId={activeBot?.id ?? null}
              workspace={workspace}
              onSelectView={setActiveView}
              onSelectBot={handleSelectBot}
              onCreateBot={handleCreateBot}
              onEditBot={handleEditBot}
              onNewChat={handleNewChat}
              onOpenIndex={() => setIndexOpen(true)}
              onOpenDiagnostics={() => setDiagnosticsOpen(true)}
              onSettings={() => setActiveView('settings')}
              onSwitchWorkspace={(dir) => {
                void window.personalAgent
                  .switchWorkspace(dir)
                  .then((r) => applyWorkspaceResult('切换工作区', r))
              }}
              onChooseWorkspace={() => {
                void window.personalAgent
                  .chooseWorkspace()
                  .then((r) => applyWorkspaceResult('切换工作区', r))
              }}
              onRemoveWorkspaceBookmark={(dir) => {
                void window.personalAgent
                  .removeWorkspaceBookmark(dir)
                  .then((r) => applyWorkspaceResult('删除书签', r))
              }}
            />
          )}

          {activeView === 'settings' ? (
            <SettingsPage
              onBack={() => setActiveView('chat')}
              onSaved={() => {
                setStatusPollKey((key) => key + 1)
                void queryClient.invalidateQueries({ queryKey: ['agentProfile'] })
              }}
            />
          ) : activeView === 'chat' ? (
            <section className="relative flex min-w-0 flex-1 flex-col">
              <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  {activeBot && (
                    <button
                      type="button"
                      title="点击编辑智能体人设"
                      onClick={() => handleEditBot(activeBot)}
                      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border pl-1 pr-2 transition-colors hover:bg-secondary"
                    >
                      <span className="grid size-5 place-items-center rounded-full bg-foreground text-[10px] leading-none text-background">
                        {activeBot.avatar || '🤖'}
                      </span>
                      <span className="max-w-[132px] truncate text-[12.5px] font-medium">
                        {activeBot.name}
                      </span>
                      <ChevronDown size={12} className="text-muted-foreground" />
                    </button>
                  )}
                  <span className="h-3.5 w-px shrink-0 bg-border" />
                  <span className="truncate text-[12.5px] text-muted-foreground">
                    {selected === null
                      ? messages.length === 0
                        ? '新对话'
                        : activeBot?.name || '会话'
                      : selected.title}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="导出本轮记录"
                    title="复制本轮记录为 Markdown"
                    onClick={() => void handleExport()}
                    className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    <Share2 size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label="更多操作"
                    onClick={() => showFeedback('更多会话操作暂未实现。')}
                    className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    <Ellipsis size={17} />
                  </button>
                </div>
              </header>

              <div className="relative flex min-h-0 flex-1 flex-col">
                <MessageStream
                  messages={messages}
                  pendingText={pendingText}
                  messagesError={messagesError}
                  feedback={feedback}
                  streamState={streamState}
                  agentName={activeBot ? activeBot.name : agentProfile?.name}
                  thinkingByTaskId={thinkingByTaskId}
                  inlineForm={
                    activeA2UIRender !== null ? (
                      <A2UIInlineCard
                        render={activeA2UIRender}
                        onSubmit={handleA2UISubmit}
                        onClose={() => setActiveA2UIRender(null)}
                      />
                    ) : null
                  }
                />

                {showWelcome && (
                  <div className="absolute inset-0 z-10 flex flex-col bg-background">
                    <WelcomeView
                      activeBot={activeBot}
                      onAction={(text) => void handleSend(text)}
                      onEditBot={handleEditBot}
                      composer={
                        <Composer
                          variant="inline"
                          running={running}
                          inputRef={inputRef}
                          activeBot={activeBot}
                          onSend={(text) => void handleSend(text)}
                          onScan={() => void handleScan()}
                          onOpenIndex={() => setIndexOpen(true)}
                          onOpenDiagnostics={() => setDiagnosticsOpen(true)}
                          onExport={() => void handleExport()}
                        />
                      }
                    />
                    {feedback !== null && (
                      <p className="pb-3 text-center text-[12px] text-muted-foreground">
                        {feedback}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 审批：自输入区上拉的非模态面板，对话仍可读可滚动 */}
              {pendingPermission !== null && (
                <PermissionCard
                  key={pendingPermission.id}
                  permission={pendingPermission}
                  onDecide={handleDecide}
                />
              )}

              {!showWelcome && (
                <Composer
                  running={running}
                  inputRef={inputRef}
                  activeBot={activeBot}
                  onSend={(text) => void handleSend(text)}
                  onScan={() => void handleScan()}
                  onOpenIndex={() => setIndexOpen(true)}
                  onOpenDiagnostics={() => setDiagnosticsOpen(true)}
                  onExport={() => void handleExport()}
                />
              )}
            </section>
          ) : (
            <WorkflowCenter onCompleted={() => void loadIndexedCount()} />
          )}
        </div>

        <IndexDialog open={indexOpen} onOpenChange={setIndexOpen} />
        <DiagnosticsDialog
          open={diagnosticsOpen}
          onOpenChange={setDiagnosticsOpen}
          taskId={lastTaskId}
        />
        <BotDialog
          open={botDialogOpen}
          onOpenChange={setBotDialogOpen}
          bot={editingBot}
          onSaved={handleBotSaved}
        />
      </div>
    </ErrorBoundary>
  )
}

export default App
