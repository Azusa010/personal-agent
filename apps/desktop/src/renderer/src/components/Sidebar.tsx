import { Activity, Files, FolderCog, MessageSquare, Plus, Settings } from 'lucide-react'
import type { ConversationSummary, RuntimeStatus } from '../../../shared/ipc-contract'
import { cn } from '@renderer/lib/utils'

export interface SidebarProps {
  conversations: ConversationSummary[]
  selectedConversationId: string | null
  runtimeStatus: RuntimeStatus | null
  indexedCount: number | null
  onSelectConversation: (conversationId: string) => void
  onNewChat: () => void
  onOpenIndex: () => void
  onOpenDiagnostics: () => void
  onSettings: () => void
}

const RUNTIME_LABELS: Record<RuntimeStatus['state'], { text: string; dot: string }> = {
  ready: { text: '运行时就绪', dot: 'bg-success' },
  starting: { text: '运行时启动中', dot: 'bg-warning' },
  crashed: { text: '运行时崩溃', dot: 'bg-destructive' },
  stopped: { text: '运行时未启动', dot: 'bg-muted-foreground' }
}

function dayKey(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '更早'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const time = date.getTime()
  if (time >= startOfToday) return '今天'
  if (time >= startOfToday - 86_400_000) return '昨天'
  return '更早'
}

/** 侧栏会话按最近活动分组。库里 list() 已按 updated_at 倒序，顺序分组即可。 */
function groupConversations(
  conversations: ConversationSummary[]
): Array<{ label: string; items: ConversationSummary[] }> {
  const groups = new Map<string, ConversationSummary[]>()
  for (const conversation of conversations) {
    const label = dayKey(conversation.updatedAt)
    const bucket = groups.get(label)
    if (bucket === undefined) groups.set(label, [conversation])
    else bucket.push(conversation)
  }
  return ['今天', '昨天', '更早']
    .filter((label) => groups.has(label))
    .map((label) => ({ label, items: groups.get(label) ?? [] }))
}

export function Sidebar({
  conversations,
  selectedConversationId,
  runtimeStatus,
  indexedCount,
  onSelectConversation,
  onNewChat,
  onOpenIndex,
  onOpenDiagnostics,
  onSettings
}: SidebarProps): React.JSX.Element {
  const runtime = RUNTIME_LABELS[runtimeStatus?.state ?? 'stopped']
  const statusText =
    indexedCount === null ? runtime.text : `${runtime.text} · 索引 ${indexedCount} 份 PDF`

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-border bg-card">
      <div className="px-4 pt-5">
        <div className="flex items-center gap-2.5 px-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Files size={16} />
          </div>
          <div>
            <h1 className="m-0 text-[14px] font-semibold tracking-tight">personal-agent</h1>
            <p className="m-0 mt-0.5 text-[11px] text-muted-foreground">本地文档工作台</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onNewChat}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Plus size={16} />
          新对话
        </button>
      </div>

      <nav className="mt-6 flex-1 overflow-y-auto px-3" aria-label="历史会话">
        {conversations.length === 0 && (
          <p className="px-2 text-[11px] text-muted-foreground">还没有历史会话</p>
        )}
        {groupConversations(conversations).map((group) => (
          <div key={group.label}>
            <p className="mb-2 mt-6 px-2 text-[11px] font-medium text-muted-foreground first:mt-0">
              {group.label}
            </p>
            <div className="space-y-1">
              {group.items.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => onSelectConversation(conversation.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px]',
                    conversation.id === selectedConversationId
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
                  )}
                >
                  <MessageSquare size={14} className="shrink-0" />
                  <span className="truncate">{conversation.title}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-4">
        <div className="flex items-center gap-2 text-[12px] text-foreground">
          <span className={cn('h-2 w-2 rounded-full', runtime.dot)} />
          {statusText}
        </div>
        <div className="mt-3 flex items-center gap-1">
          <button
            type="button"
            title="索引管理"
            aria-label="索引管理"
            onClick={onOpenIndex}
            className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <FolderCog size={16} />
          </button>
          <button
            type="button"
            title="运行诊断"
            aria-label="运行诊断"
            onClick={onOpenDiagnostics}
            className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Activity size={16} />
          </button>
          <button
            type="button"
            title="设置"
            aria-label="设置"
            onClick={onSettings}
            className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}
