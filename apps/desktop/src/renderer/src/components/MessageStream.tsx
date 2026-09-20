import { useEffect } from 'react'
import { Bot, LoaderCircle } from 'lucide-react'
import type { MessageView } from '../../../shared/ipc-contract'
import { ScrollPinButton, TextShimmer, ThoughtChainViewer, useScrollAnchor } from '../thought-chain'
import { extractFacts, getTimelineStepCount, type LiveStreamState } from '../view-model'

export interface MessageStreamProps {
  messages: MessageView[]
  /** 发送后、落库读回前的过渡态：乐观渲染这条用户气泡与「正在处理」 */
  pendingText: string | null
  streamState: LiveStreamState | null
  messagesError: string | null
  feedback: string | null
  agentName?: string
  thinkingByTaskId?: Record<string, string>
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

      {/* 2. 下层：最后的正文 */}
      <div className="pt-0.5">
        <p className="m-0 whitespace-pre-wrap">{message.text}</p>
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
                      className="ml-1 inline-flex rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
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
  thinkingByTaskId
}: MessageStreamProps): React.JSX.Element {
  const { containerRef, hasNewContentBelow, scrollToBottom, notifyContentGrowth } =
    useScrollAnchor()

  const waiting = pendingText !== null

  useEffect(() => {
    notifyContentGrowth()
  }, [messages, pendingText, feedback, streamState, notifyContentGrowth])

  return (
    <div className="relative min-h-0 flex-1 flex flex-col">
      <div ref={containerRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {messagesError !== null && (
          <p className="text-center text-[12px] text-destructive">{messagesError}</p>
        )}
        {messages.length === 0 && !waiting && messagesError === null && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-secondary">
              <Bot size={18} />
            </div>
            <p className="m-0 text-[13px]">问点什么，需要动文件的操作会先请求批准。</p>
          </div>
        )}
        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div key={message.seq} className="flex justify-end">
                <div className="max-w-[73%] rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-[13px] leading-5">
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
              <div className="max-w-[73%] rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-[13px] leading-5">
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
        {feedback !== null && (
          <p className="text-center text-[12px] text-muted-foreground">{feedback}</p>
        )}
      </div>

      <ScrollPinButton visible={hasNewContentBelow} onClick={() => scrollToBottom(true)} />
    </div>
  )
}
