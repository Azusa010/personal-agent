import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'
import type { MessageView, TaskTimeline } from '../../../shared/ipc-contract'
import { describeEvent, describePlanSteps, extractFacts, type LiveStreamState } from '../view-model'

export interface MessageStreamProps {
  messages: MessageView[]
  /** 发送后、落库读回前的过渡态：乐观渲染这条用户气泡与「正在处理」 */
  pendingText: string | null
  streamState: LiveStreamState | null
  messagesError: string | null
  feedback: string | null
}

function durationSeconds(timeline: TaskTimeline): string | null {
  const first = timeline.events[0]
  const last = timeline.events[timeline.events.length - 1]
  if (first === undefined || last === undefined) return null
  const ms = new Date(last.occurredAt).getTime() - new Date(first.occurredAt).getTime()
  if (Number.isNaN(ms) || ms < 0) return null
  return (ms / 1000).toFixed(1)
}

/** assistant 气泡：正文 + （该轮有任务时）facts 页码与折叠步骤。展开状态每条自带。 */
function AssistantMessage({ message }: { message: MessageView }): React.JSX.Element {
  const [stepsOpen, setStepsOpen] = useState(false)
  const timeline = message.timeline
  const facts = timeline === null ? [] : extractFacts(timeline.events)

  return (
    <div className="max-w-[82%] text-[13px] leading-5">
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
      {timeline !== null && timeline.events.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setStepsOpen((open) => !open)}
            className="mt-2 flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-secondary"
          >
            <span className="flex items-center gap-2">
              {stepsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              已执行 {timeline.events.length} 个步骤
              {durationSeconds(timeline) !== null && (
                <span className="text-foreground">{durationSeconds(timeline)}s</span>
              )}
            </span>
            <span>{stepsOpen ? '收起' : '查看'}</span>
          </button>
          {stepsOpen && (
            <ol className="mt-2 space-y-1 rounded-md border border-border bg-card px-3 py-2.5 text-[12px] text-muted-foreground">
              {timeline.plan !== null
                ? describePlanSteps(timeline.plan).map((step) => (
                    <li key={step.index}>
                      {step.index}. {step.description}（{step.capabilityLabel}）
                    </li>
                  ))
                : timeline.events.map((event) => {
                    const line = describeEvent(event)
                    return (
                      <li key={event.seq}>
                        {line.seq}. {line.label} · {line.summary}
                      </li>
                    )
                  })}
            </ol>
          )}
        </>
      )}
    </div>
  )
}

export function MessageStream({
  messages,
  pendingText,
  streamState,
  messagesError,
  feedback
}: MessageStreamProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  const waiting = pendingText !== null

  useEffect(() => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages, pendingText, feedback, streamState])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
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
      {messages.map((message) =>
        message.role === 'user' ? (
          <div key={message.seq} className="flex justify-end">
            <div className="max-w-[73%] rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-[13px] leading-5">
              {message.text}
            </div>
          </div>
        ) : (
          <article key={message.seq} className="flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground">
              <Bot size={15} />
            </div>
            <AssistantMessage message={message} />
          </article>
        )
      )}
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
            <div className="max-w-[82%] space-y-2 text-[13px] leading-5">
              {streamState?.thinking ? (
                <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-[12px] leading-relaxed">
                  <div className="mb-1.5 flex items-center gap-1.5 font-medium text-muted-foreground">
                    <LoaderCircle size={13} className="animate-spin text-primary" />
                    <span>思考中…</span>
                  </div>
                  <div className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                    {streamState.thinking}
                  </div>
                </div>
              ) : null}
              {streamState?.events && streamState.events.length > 0 ? (
                <div className="space-y-1 text-[12px] text-muted-foreground">
                  <div className="font-medium text-foreground">执行步骤：</div>
                  <ol className="space-y-1 pl-1">
                    {streamState.events.map((event, idx) => {
                      const line = describeEvent({
                        seq: idx + 1,
                        taskId: streamState.taskId ?? '',
                        type: event.type,
                        payload: event.payload,
                        occurredAt: event.occurredAt
                      })
                      return (
                        <li key={idx} className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {line.seq}.
                          </span>
                          <span className="font-medium text-foreground">{line.label}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="truncate">{line.summary}</span>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              ) : null}
              {!streamState?.thinking &&
              (!streamState?.events || streamState.events.length === 0) ? (
                <p className="m-0 flex items-center gap-2 text-muted-foreground">
                  <LoaderCircle size={14} className="animate-spin" />
                  正在处理，会改动文件的操作会先弹批准面板…
                </p>
              ) : null}
            </div>
          </article>
        </>
      )}
      {feedback !== null && (
        <p className="text-center text-[12px] text-muted-foreground">{feedback}</p>
      )}
    </div>
  )
}
