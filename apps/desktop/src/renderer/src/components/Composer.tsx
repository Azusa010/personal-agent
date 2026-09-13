import { useState } from 'react'
import {
  Activity,
  ArrowUp,
  Columns2,
  Download,
  FileText,
  FolderCog,
  FolderOpen,
  Paperclip,
  ScanSearch
} from 'lucide-react'

export interface ComposerProps {
  running: boolean
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onSend: (goal: string) => void
  onScan: () => void
  onOpenIndex: () => void
  onOpenDiagnostics: () => void
  onExport: () => void
}

interface QuickAction {
  label: string
  icon: React.JSX.Element
  /** 有 prompt 的芯片把示例指令填进输入框；没有的直接触发动作 */
  prompt?: string
  run?: (props: ComposerProps) => void
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: '全文摘要',
    icon: <FileText size={14} />,
    prompt: '请对当前索引里的全部 PDF 做全文摘要'
  },
  {
    label: '两文档对比',
    icon: <Columns2 size={14} />,
    prompt: '对比索引里两份 PDF 的付款条款差异'
  },
  {
    label: '关键条款提取',
    icon: <ScanSearch size={14} />,
    prompt: '提取当前合同中的关键条款与风险点'
  },
  { label: '索引管理', icon: <FolderCog size={14} />, run: (p) => p.onOpenIndex() },
  { label: '运行诊断', icon: <Activity size={14} />, run: (p) => p.onOpenDiagnostics() },
  { label: '导出 Markdown', icon: <Download size={14} />, run: (p) => p.onExport() }
]

export function Composer(props: ComposerProps): React.JSX.Element {
  const { running, inputRef, onSend } = props
  const [value, setValue] = useState('')

  const send = (): void => {
    const goal = value.trim()
    if (goal.length === 0 || running) return
    setValue('')
    onSend(goal)
  }

  return (
    <footer className="shrink-0 px-6 pb-4 pt-3">
      <div className="rounded-xl border border-border bg-card p-2">
        <textarea
          ref={inputRef}
          rows={2}
          aria-label="输入消息"
          placeholder="问点什么，或让它去读某份 PDF…"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          className="block w-full resize-none border-0 bg-transparent px-2 py-1.5 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between px-1">
          <div className="flex gap-1">
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
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            <span>{running ? '执行中' : '发送'}</span>
            <ArrowUp size={14} />
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 pt-2">
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                if (action.run !== undefined) {
                  action.run(props)
                  return
                }
                setValue(action.prompt ?? '')
                inputRef.current?.focus()
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
        <p className="m-0 shrink-0 text-[11px] text-muted-foreground">
          Enter 发送 · Shift+Enter 换行
        </p>
      </div>
    </footer>
  )
}
