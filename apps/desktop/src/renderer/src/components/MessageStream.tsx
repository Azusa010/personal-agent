import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, LoaderCircle } from 'lucide-react'
import type {
  MessageView,
  PermissionDecision,
  PermissionRecord
} from '../../../shared/ipc-contract'
import { ScrollPinButton, TextShimmer, ThoughtChainViewer, useScrollAnchor } from '../thought-chain'
import { extractFacts, getTimelineStepCount, type LiveStreamState } from '../view-model'
import { MarkdownContent } from './MarkdownContent'
import { PermissionCard } from './PermissionCard'
import { cn } from '@renderer/lib/utils'

export interface MessageStreamProps {
  messages: MessageView[]
  /** 发送后、落库读回前的过渡态：乐观渲染这条用户气泡与「正在处理」 */
  pendingText: string | null
  streamState: LiveStreamState | null
  messagesError: string | null
  feedback: string | null
  agentName?: string
  thinkingByTaskId?: Record<string, string>
  /** 流内权限审批卡:非空时卡片渲染在消息流末尾 */
  pendingPermission: PermissionRecord | null
  onDecidePermission: (decision: PermissionDecision) => Promise<void>
}

/** assistant 气泡：思考步骤 -> （连线） -> 最后的正文。 */
function AssistantMessage({
  message,
  cachedThinking
}: {
  message: MessageView
  cachedThinking?: string
}): React.JSX.Element {
  const timeline = message.timeline
  const facts = timeline === null ? [] : extractFacts(timeline.events)
  const stepsCount = getTimelineStepCount(timeline)
  const hasTrajectory = (timeline !== null && stepsCount > 0) || Boolean(cachedThinking)

  return (
    <div className="max-w-[82%] text-[13px] leading-5 space-y-1.5">
      {/* 1. 上层：思考步骤与执行轨迹 (直接以 agent-elements 轻量行展示) */}
      {hasTrajectory && (
        <div className="space-y-1">
          <ThoughtChainViewer timeline={timeline} cachedThinking={cachedThinking} />
        </div>
      )}

      {/* 结构垂直连线：思考步骤 -> (|) -> 正文 */}
      {hasTrajectory && (Boolean(message.text) || facts.length > 0) && (
        <div className="ml-1.5 flex h-3 items-center border-l border-border/50 pl-2 select-none">
          <span className="text-[9px] text-muted-foreground/40 font-mono">↓</span>
        </div>
      )}

      {/* 2. 下层：最后的正文（Agent 的话用衬线呈现，Claude 式人机对照） */}
      <div className="font-serif pt-0.5 text-[13.5px] leading-6">
        <MarkdownContent content={message.text} />
        {facts.length > 0 && (
          <>
            <p className="m-0 mt-2 text-muted-foreground">依据本地文件核对，结论如下：</p>
            <ul className="my-2 list-disc space-y-1 pl-5">
              {facts.map((fact, i) => (
                <li key={i}>
                  {fact.text}
                  {fact.pageRefs.map((page) => (
                    <span
                      key={page}
                      className="ml-1 inline-flex rounded bg-[var(--mint-tint)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--mint-deep)]"
                    >
                      p.{page}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

export function MessageStream({
  messages,
  pendingText,
  streamState,
  messagesError,
  feedback,
  agentName = 'PersonalAgent',
  thinkingByTaskId,
  pendingPermission,
  onDecidePermission
}: MessageStreamProps): React.JSX.Element {
  const { containerRef, hasNewContentBelow, scrollToBottom, notifyContentGrowth } =
    useScrollAnchor()

  const waiting = pendingText !== null

  useEffect(() => {
    notifyContentGrowth()
  }, [messages, pendingText, feedback, streamState, pendingPermission, notifyContentGrowth])

  /* ── 消息轨(ZCode 式):每条 User 消息一格,点击跳转,滚动时指示当前位置 ── */
  const userTurns = useMemo(
    () => messages.filter((m) => m.role === 'user').map((m) => m.seq),
    [messages]
  )
  const [railActive, setRailActive] = useState<number | null>(null)
  const [flashSeq, setFlashSeq] = useState<number | null>(null)
  const flashTimer = useRef<number | null>(null)
  const railRaf = useRef(0)

  const jumpToMessage = useCallback((seq: number): void => {
    const el = document.getElementById('user-msg-' + seq)
    if (el === null) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setRailActive(seq)
    setFlashSeq(seq)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashSeq(null), 1300)
  }, [])

  const handleRailScroll = useCallback((): void => {
    if (railRaf.current !== 0) return
    railRaf.current = window.requestAnimationFrame(() => {
      railRaf.current = 0
      const root = containerRef.current
      if (root === null) return
      const rootTop = root.getBoundingClientRect().top
      let best: number | null = null
      let bestDist = Number.POSITIVE_INFINITY
      for (const seq of userTurns) {
        const el = document.getElementById('user-msg-' + seq)
        if (el === null) continue
        const dist = Math.abs(el.getBoundingClientRect().top - rootTop - 24)
        if (dist < bestDist) {
          bestDist = dist
          best = seq
        }
      }
      setRailActive(best)
    })
  }, [userTurns, containerRef])

  // 卸载时清掉轨上的定时器与动画帧
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
      if (railRaf.current !== 0) window.cancelAnimationFrame(railRaf.current)
    },
    []
  )

  return (
    <div className="relative min-h-0 flex-1 flex flex-col">
      <div
        ref={containerRef}
        onScroll={handleRailScroll}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5"
      >
        {messagesError !== null && (
          <p className="text-center text-[12px] text-destructive">{messagesError}</p>
        )}
        {messages.length === 0 && !waiting && messagesError === null && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border-0 bg-gradient-to-br from-[var(--mint)] to-[var(--mint-deep)] text-white">
              <Bot size={18} />
            </div>
            <p className="m-0 text-[13px]">问点什么，需要动文件的操作会先请求批准。</p>
          </div>
        )}
        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div
                key={message.seq}
                id={'user-msg-' + message.seq}
                className="flex scroll-mt-4 justify-end"
              >
                <div
                  className={cn(
                    'max-w-[73%] rounded-2xl rounded-br-md border border-[var(--mint-line)] bg-[var(--mint-tint)] px-4 py-3 text-[13px] leading-5 text-[#1d4f49]',
                    flashSeq === message.seq && 'msg-flash'
                  )}
                >
                  {message.text}
                </div>
              </div>
            )
          }

          const taskId = message.taskId ?? message.timeline?.task.id ?? null
          const cachedThinking = taskId && thinkingByTaskId ? thinkingByTaskId[taskId] : undefined

          return (
            <article key={message.seq} className="flex items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground">
                <Bot size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                  {agentName}
                </div>
                <AssistantMessage message={message} cachedThinking={cachedThinking} />
              </div>
            </article>
          )
        })}
        {waiting && (
          <>
            <div className="flex justify-end">
              <div className="max-w-[73%] rounded-2xl rounded-br-md border border-[var(--mint-line)] bg-[var(--mint-tint)] px-4 py-3 text-[13px] leading-5 text-[#1d4f49]">
                {pendingText}
              </div>
            </div>
            <article className="flex items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground">
                <Bot size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                  {agentName}
                </div>
                <div className="max-w-[82%] space-y-2 text-[13px] leading-5">
                  {streamState &&
                  (streamState.thinking ||
                    (streamState.events && streamState.events.length > 0)) ? (
                    <div className="space-y-1">
                      <ThoughtChainViewer liveStream={streamState} isStreaming={true} />
                      <div className="ml-1.5 flex h-3 items-center border-l border-border/50 pl-2 select-none">
                        <span className="text-[9px] text-muted-foreground/40 font-mono">↓</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground select-none">
                      <LoaderCircle
                        size={12}
                        className="animate-spin text-muted-foreground shrink-0"
                      />
                      <TextShimmer duration={1.2} className="text-xs font-[450]">
                        Thinking...
                      </TextShimmer>
                    </div>
                  )}
                </div>
              </div>
            </article>
          </>
        )}
        {/* 流内权限审批卡:决定后 App 清空 pendingPermission,卡片随之消失 */}
        {pendingPermission !== null && (
          <div className="flex justify-center">
            <div className="w-full max-w-[560px]">
              <PermissionCard
                key={pendingPermission.id}
                permission={pendingPermission}
                onDecide={onDecidePermission}
              />
            </div>
          </div>
        )}
        {feedback !== null && (
          <p className="text-center text-[12px] text-muted-foreground">{feedback}</p>
        )}
      </div>

      {/* 消息轨:竖排在左缘留白里,悬停拉长浮出提示,点击跳转 */}
      {userTurns.length > 0 && (
        <nav
          aria-label="消息导航"
          className="absolute top-1/2 left-2 z-10 flex -translate-y-1/2 flex-col items-center gap-2.5"
        >
          {userTurns.map((seq) => (
            <button
              key={seq}
              type="button"
              title="跳转到这条消息"
              aria-label={'跳转到第 ' + seq + ' 条消息'}
              onClick={() => jumpToMessage(seq)}
              className={cn(
                'h-[2px] w-2.5 rounded-full transition-all duration-150 hover:w-4',
                railActive === seq
                  ? 'bg-[var(--mint)]'
                  : 'bg-muted-foreground/30 hover:bg-[var(--mint-deep)]'
              )}
            />
          ))}
        </nav>
      )}

      <ScrollPinButton visible={hasNewContentBelow} onClick={() => scrollToBottom(true)} />
    </div>
  )
}
