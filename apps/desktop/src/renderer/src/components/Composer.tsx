import { useState } from 'react'
import { ArrowUp, FolderOpen, LoaderCircle, Paperclip, Plus } from 'lucide-react'
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
  /** docked = 贴窗口底部的常驻输入区；inline = 新对话态里跟随 hero 居中 */
  variant?: 'docked' | 'inline'
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const { running, inputRef, onSend, activeBot, variant = 'docked' } = props
  const [value, setValue] = useState('')

  const send = (): void => {
    const goal = value.trim()
    if (goal.length === 0 || running) return
    setValue('')
    onSend(goal)
  }

  const placeholderText = activeBot
    ? `向${activeBot.name}发送消息，或让它去做一件事…`
    : '问点什么，或让它去读某份 PDF…'

  return (
    <footer className={variant === 'inline' ? 'w-full' : 'shrink-0 px-6 pb-4 pt-1'}>
      <div className={variant === 'inline' ? 'w-full' : 'mx-auto w-full max-w-[760px]'}>
        <div className="rounded-[16px] border border-[#e4e4e7] bg-background px-3 pb-2 pt-3 shadow-[0_1px_2px_rgba(9,9,11,0.04),0_8px_24px_-14px_rgba(9,9,11,0.12)] transition-colors focus-within:border-[#d4d4d8]">
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
            className="block max-h-40 w-full resize-none border-0 bg-transparent px-1 py-1 text-[14px] leading-[1.7] text-foreground outline-none placeholder:text-[#a1a1aa]"
          />
          <div className="mt-1 flex items-center justify-between gap-2 px-1">
            <div className="flex min-w-0 items-center gap-0.5">
              <button
                type="button"
                aria-label="扫描 Downloads 里的 PDF"
                title="扫描 Downloads 里的 PDF"
                onClick={props.onScan}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                aria-label="查看索引"
                title="查看索引"
                onClick={props.onOpenIndex}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Paperclip size={15} />
              </button>
              <button
                type="button"
                aria-label="运行诊断"
                title="运行诊断"
                onClick={props.onOpenDiagnostics}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <FolderOpen size={15} />
              </button>
              {activeBot && (
                <span className="ml-1.5 inline-flex h-6 max-w-[160px] items-center gap-1.5 rounded-full border border-border px-2 text-[11px] text-muted-foreground">
                  <span className="leading-none">{activeBot.avatar || '🤖'}</span>
                  <span className="truncate font-medium text-foreground/80">{activeBot.name}</span>
                </span>
              )}
            </div>
            <button
              type="button"
              disabled={running || value.trim().length === 0}
              onClick={send}
              aria-label={running ? '执行中' : '发送'}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:bg-[#f4f4f5] disabled:text-[#c9c9ce]"
            >
              {running ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : (
                <ArrowUp size={16} />
              )}
            </button>
          </div>
        </div>
      </div>
    </footer>
  )
}
