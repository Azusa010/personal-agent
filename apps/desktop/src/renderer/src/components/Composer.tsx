import { useState } from 'react'
import { ArrowUp, FolderOpen, Paperclip } from 'lucide-react'
import type { BotView } from '../../../shared/ipc-contract'

export interface ComposerProps {
  running: boolean
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  activeBot?: BotView | null
  onSend: (goal: string) => void
  onScan?: () => void
  onOpenIndex?: () => void
  onOpenDiagnostics?: () => void
  onExport?: () => void
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const { running, inputRef, onSend, activeBot } = props
  const [value, setValue] = useState('')

  const send = (): void => {
    const goal = value.trim()
    if (goal.length === 0 || running) return
    setValue('')
    onSend(goal)
  }

  const placeholderText = activeBot
    ? `向 ${activeBot.name} 发送消息或任务指令…`
    : '问点什么，或让它去读某份 PDF…'

  return (
    <footer className="shrink-0 px-6 pb-4 pt-2">
      <div className="rounded-[20px] border border-input bg-card px-4 pt-3 pb-2.5 shadow-[0_1px_2px_rgba(94,80,53,0.05),0_8px_28px_rgba(94,80,53,0.08)] transition-shadow focus-within:shadow-[0_1px_2px_rgba(94,80,53,0.05),0_8px_28px_rgba(15,157,143,0.14)]">
        <textarea
          ref={inputRef}
          rows={2}
          aria-label="输入消息"
          placeholder={placeholderText}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          className="block w-full resize-none border-0 bg-transparent px-1 py-1.5 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1">
            {activeBot && (
              <div
                className="flex items-center gap-1.5 rounded-full bg-secondary/80 border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground mr-1 shadow-2xs"
                title={`当前对话智能体：${activeBot.name}`}
              >
                <span>{activeBot.avatar || '🤖'}</span>
                <span className="font-medium text-foreground max-w-[100px] truncate">
                  {activeBot.name}
                </span>
              </div>
            )}
            <button
              type="button"
              aria-label="扫描 Downloads 里的 PDF"
              title="扫描 Downloads 里的 PDF"
              onClick={props.onScan}
              className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Paperclip size={16} />
            </button>
            <button
              type="button"
              aria-label="查看索引"
              title="查看索引"
              onClick={props.onOpenIndex}
              className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <FolderOpen size={16} />
            </button>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={send}
            className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-[12px] font-medium text-primary-foreground shadow-[0_4px_12px_rgba(15,157,143,0.35)] hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none"
          >
            <span>{running ? '执行中' : '发送'}</span>
            <ArrowUp size={14} />
          </button>
        </div>
      </div>
    </footer>
  )
}
