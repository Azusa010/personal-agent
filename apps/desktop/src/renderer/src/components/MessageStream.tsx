import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, LoaderCircle, ShieldAlert } from 'lucide-react'
import type { TaskTimeline } from '../../../shared/ipc-contract'
import {
  describeEvent,
  describePlanSteps,
  extractFacts,
  extractReply,
  STATUS_LABELS,
  summarizePayload
} from '../view-model'

export interface MessageStreamProps {
  timeline: TaskTimeline | null
  /** 发送后、任务落库前的过渡态：先给用户气泡与「正在整理」，不让界面空着 */
  pendingGoal: string | null
  timelineError: string | null
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

function failureReason(timeline: TaskTimeline): string {
  for (let i = timeline.events.length - 1; i >= 0; i--) {
    const event = timeline.events[i]
    if (event !== undefined && event.type === 'task_failed') {
      return summarizePayload(event.type, event.payload)
    }
  }
  return '未知原因'
}

export function MessageStream({
  timeline,
  pendingGoal,
  timelineError,
  feedback
}: MessageStreamProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stepsOpen, setStepsOpen] = useState(false)

  const status = pendingGoal !== null ? 'running' : (timeline?.task.status ?? null)
  const goal = pendingGoal ?? timeline?.task.goal ?? null
  const reply = timeline !== null ? extractReply(timeline.events) : null
  const facts = timeline !== null ? extractFacts(timeline.events) : []

  useEffect(() => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [timeline, pendingGoal, feedback, stepsOpen])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
      {timelineError !== null && (
        <p className="text-center text-[12px] text-destructive">{timelineError}</p>
      )}

      {goal === null && timelineError === null && (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-secondary">
            <Bot size={18} />
          </div>
          <p className="m-0 text-[13px]">问点什么</p>
        </div>
      )}

      {goal !== null && (
        <div className="flex justify-end">
          <div className="max-w-[73%] rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-[13px] leading-5">
            {goal}
          </div>
        </div>
      )}

      {goal !== null && (
        <article className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground">
            <Bot size={15} />
          </div>
          <div className="max-w-[82%] text-[13px] leading-5">
            {(status === 'running' || status === 'pending') && (
              <p className="m-0 flex items-center gap-2 text-muted-foreground">
                <LoaderCircle size={14} className="animate-spin" />
                {STATUS_LABELS[status]}，正在仅基于本地文件整理回答…
              </p>
            )}
            {status === 'waiting_permission' && (
              <p className="m-0 flex items-start gap-2 text-muted-foreground">
                <ShieldAlert size={14} className="mt-0.5 shrink-0 text-destructive" />
                任务卡在一个会改动文件的操作上，正在等你批准。请在弹出的面板里做决定， 批准窗口只有
                5 分钟。
              </p>
            )}
            {status === 'failed' && timeline !== null && (
              <p className="m-0 text-destructive">任务失败：{failureReason(timeline)}</p>
            )}
            {status === 'cancelled' && <p className="m-0 text-muted-foreground">任务已取消。</p>}
            {status === 'completed' && timeline !== null && (
              <>
                {reply !== null && <p className="m-0 whitespace-pre-wrap">{reply}</p>}
                {facts.length > 0 && (
                  <>
                    <p className="m-0">已对本地文件做了核对，结论如下：</p>
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
                {reply === null && facts.length === 0 && (
                  <p className="m-0">任务完成，但没有产出摘要。</p>
                )}
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
        </article>
      )}

      {feedback !== null && (
        <p className="text-center text-[12px] text-muted-foreground">{feedback}</p>
      )}
    </div>
  )
}
