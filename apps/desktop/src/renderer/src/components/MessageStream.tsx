import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Sparkles } from 'lucide-react'
import type { MessageView } from '../../../shared/ipc-contract'
import { ScrollPinButton, TextShimmer, ThoughtChainViewer, useScrollAnchor } from '../thought-chain'
import { extractFacts, getTimelineStepCount, type LiveStreamState } from '../view-model'
import { MarkdownContent } from './MarkdownContent'
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
  /** 需要补齐字段时，A2UI 表单直接接在消息流末尾 */
  inlineForm?: React.ReactNode
}

/** assistant 正文区：执行叙述 → 正文 → 依据。全部直接落在画布上，没有一层外壳。 */
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
    <div className="w-full space-y-3 text-[13.5px] leading-[1.85]">
      {hasTrajectory && <ThoughtChainViewer timeline={timeline} cachedThinking={cachedThinking} />}

      <div className="space-y-3 text-foreground/95">
        <MarkdownContent content={message.text} />

        {facts.length > 0 && (
          <div className="border-t border-dashed border-[#e8e8ea] pt-2.5">
            <p className="m-0 mb-1.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
              <span className="inline-block size-[3px] rounded-full bg-muted-foreground/60" />
              以下结论来自本地文件，可逐条核对
            </p>
            <ul className="m-0 list-none space-y-1 p-0 text-[12.5px] text-[#52525b]">
              {facts.map((fact, index) => (
                <li key={index} className="flex flex-wrap items-baseline gap-1.5">
                  <span>{fact.text}</span>
                  {fact.pageRefs.map((page) => (
                    <span
                      key={page}
                      className="inline-flex rounded border border-[#e0e7ff] bg-[#eef2ff] px-1 py-[0.5px] font-mono text-[10px] text-[#4338ca]"
                    >
                      p.{page}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

function AssistantAvatar(): React.JSX.Element {
  return (
    <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-[7px] bg-foreground text-background">
      <Sparkles size={12} strokeWidth={2.2} />
    </div>
  )
}

export function MessageStream({
  messages,
  pendingText,
  streamState,
  messagesError,
  feedback,
  agentName = 'Personal Agent',
  thinkingByTaskId,
  inlineForm
}: MessageStreamProps): React.JSX.Element {
  const { containerRef, hasNewContentBelow, scrollToBottom, notifyContentGrowth } =
    useScrollAnchor()

  const waiting = pendingText !== null
  const hasInlineForm = inlineForm !== null && inlineForm !== undefined

  useEffect(() => {
    notifyContentGrowth()
  }, [messages, pendingText, feedback, streamState, hasInlineForm, notifyContentGrowth])

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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleRailScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[760px] px-6 py-5">
          {messagesError !== null && (
            <p className="text-center text-[12px] text-destructive">{messagesError}</p>
          )}
          {messages.length === 0 && !waiting && messagesError === null && (
            <div className="flex min-h-[40vh] items-center justify-center">
              <p className="m-0 text-[13px] text-muted-foreground">
                问点什么，需要动文件的操作会先请你批准。
              </p>
            </div>
          )}

          <div className="flex flex-col gap-7">
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
                        'max-w-[80%] rounded-[16px] bg-[#f4f4f5] px-4 py-2.5 text-[13.5px] leading-relaxed text-foreground',
                        flashSeq === message.seq && 'msg-flash'
                      )}
                    >
                      {message.text}
                    </div>
                  </div>
                )
              }

              const taskId = message.taskId ?? message.timeline?.task.id ?? null
              const cachedThinking =
                taskId && thinkingByTaskId ? thinkingByTaskId[taskId] : undefined

              return (
                <article key={message.seq} className="flex items-start gap-3">
                  <AssistantAvatar />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                      <span className="font-medium text-[#3f3f46]">{agentName}</span>
                    </div>
                    <AssistantMessage message={message} cachedThinking={cachedThinking} />
                  </div>
                </article>
              )
            })}

            {waiting && (
              <>
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-[16px] bg-[#f4f4f5] px-4 py-2.5 text-[13.5px] leading-relaxed text-foreground">
                    {pendingText}
                  </div>
                </div>
                <article className="flex items-start gap-3">
                  <AssistantAvatar />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 text-[11.5px] font-medium text-[#3f3f46]">{agentName}</div>
                    {streamState &&
                    (streamState.thinking ||
                      (streamState.events && streamState.events.length > 0)) ? (
                      <ThoughtChainViewer liveStream={streamState} isStreaming />
                    ) : (
                      <div className="flex select-none items-center gap-1.5 py-0.5">
                        <LoaderCircle size={12} className="shrink-0 animate-spin text-[#a1a1aa]" />
                        <TextShimmer duration={1.2} className="text-[12.5px] font-[450]">
                          正在理解你的请求…
                        </TextShimmer>
                      </div>
                    )}
                  </div>
                </article>
              </>
            )}

            {inlineForm}

            {feedback !== null && (
              <p className="m-0 text-center text-[11.5px] text-muted-foreground">{feedback}</p>
            )}
          </div>
        </div>
      </div>

      {/* 消息轨:竖排在左缘留白里,悬停拉长浮出提示,点击跳转 */}
      {userTurns.length > 0 && (
        <nav
          aria-label="消息导航"
          className="absolute left-2 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-2.5"
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
                railActive === seq ? 'bg-[#4f46e5]' : 'bg-muted-foreground/25 hover:bg-[#4338ca]'
              )}
            />
          ))}
        </nav>
      )}

      <ScrollPinButton visible={hasNewContentBelow} onClick={() => scrollToBottom(true)} />
    </div>
  )
}
