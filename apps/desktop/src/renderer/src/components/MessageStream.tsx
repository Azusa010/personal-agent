import { useEffect, useState } from 'react'
import { Bot, Brain, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'
import type { MessageView, TaskTimeline } from '../../../shared/ipc-contract'
import { ScrollPinButton, ThoughtChainViewer, useScrollAnchor } from '../thought-chain'
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

function durationSeconds(timeline: TaskTimeline): string | null {
  const first = timeline.events[0]
  const last = timeline.events[timeline.events.length - 1]
  if (first === undefined || last === undefined) return null
  const ms = new Date(last.occurredAt).getTime() - new Date(first.occurredAt).getTime()
  if (Number.isNaN(ms) || ms < 0) return null
  return (ms / 1000).toFixed(1)
}

/** assistant 气泡：思考步骤 -> （连线） -> 最后的正文。 */
function AssistantMessage({
  message,
  cachedThinking
}: {
  message: MessageView
  cachedThinking?: string
}): React.JSX.Element {
  const [stepsOpen, setStepsOpen] = useState(true)
  const timeline = message.timeline
  const facts = timeline === null ? [] : extractFacts(timeline.events)
  const stepsCount = getTimelineStepCount(timeline)
  const hasTrajectory = (timeline !== null && stepsCount > 0) || Boolean(cachedThinking)

  return (
    <div className="max-w-[82%] text-[13px] leading-5 space-y-2">
      {/* 1. 上层：思考步骤与执行轨迹 */}
      {hasTrajectory && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setStepsOpen((open) => !open)}
            className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-secondary transition-colors"
          >
            <span className="flex items-center gap-2">
              {stepsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              已执行 {stepsCount > 0 ? `${stepsCount} 个步骤` : '思维链推理'}
              {timeline !== null && durationSeconds(timeline) !== null && (
                <span className="text-foreground">{durationSeconds(timeline)}s</span>
              )}
            </span>
            <span>{stepsOpen ? '收起' : '查看轨迹'}</span>
          </button>
          {stepsOpen && (
            <div className="pt-1">
              <ThoughtChainViewer timeline={timeline} cachedThinking={cachedThinking} />
            </div>
          )}
        </div>
      )}

      {/* 2. 下层：最后的正文 */}
      <div>
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
                    <div className="space-y-1.5">
                      <ThoughtChainViewer liveStream={streamState} isStreaming={true} />
                      <div className="ml-4 flex h-3 items-center border-l-2 border-border/80 pl-2">
                        <span className="text-[10px] text-muted-foreground/60 select-none">
                          ↓ 正在生成正文...
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-indigo-200/80 bg-indigo-50/40 p-3 text-xs dark:border-indigo-900/50 dark:bg-indigo-950/20">
                      <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-medium">
                        <Brain size={14} className="animate-pulse text-indigo-500" />
                        <span>正在深度思考与规划步骤…</span>
                        <LoaderCircle size={12} className="animate-spin ml-auto text-indigo-500" />
                      </div>
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
