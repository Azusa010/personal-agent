import { useMemo, useState } from 'react'
import { Activity, Database, MessageSquare, Plus, Search, Settings, Zap } from 'lucide-react'
import type { BotView, ConversationSummary, RuntimeStatus } from '../../../shared/ipc-contract'
import { cn } from '@renderer/lib/utils'

export type AppView = 'chat' | 'workflows' | 'settings'

export interface SidebarProps {
  conversations: ConversationSummary[]
  selectedConversationId: string | null
  runtimeStatus: RuntimeStatus | null
  indexedCount: number | null
  activeView: AppView
  bots?: BotView[]
  activeBotId?: string | null
  onSelectView: (view: AppView) => void
  onSelectConversation: (conversationId: string) => void
  onSelectBot?: (bot: BotView) => void
  onCreateBot?: () => void
  onEditBot?: (bot: BotView) => void
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
  activeView,
  bots = [],
  activeBotId,
  onSelectView,
  onSelectConversation,
  onSelectBot,
  onCreateBot,
  onEditBot,
  onNewChat,
  onOpenIndex,
  onOpenDiagnostics,
  onSettings
}: SidebarProps): React.JSX.Element {
  const runtime = RUNTIME_LABELS[runtimeStatus?.state ?? 'stopped']
  const [query, setQuery] = useState('')

  // 过滤掉已作为专有智能体伴侣常驻会话的记录，避免历史列表中产生重复项
  const filtered = useMemo(() => {
    const botConvIds = new Set(bots.map((b) => b.conversationId).filter(Boolean))
    const keyword = query.trim().toLowerCase()
    const base = conversations.filter((c) => !botConvIds.has(c.id))
    if (keyword === '') return base
    return base.filter((c) => c.title.toLowerCase().includes(keyword))
  }, [conversations, query, bots])

  const navItems = [
    { id: 'chat' as const, label: '对话', icon: MessageSquare },
    { id: 'workflows' as const, label: '工作流', icon: Zap }
  ]

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-background">
      {/* 新建与搜索 */}
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-2">
        <button
          type="button"
          onClick={onNewChat}
          className="flex h-[34px] w-full items-center gap-2 rounded-[9px] border border-border px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-secondary/70"
        >
          <Plus size={15} className="text-muted-foreground" />
          新对话
          <kbd className="ml-auto rounded border border-border px-1 py-[0.5px] font-mono text-[9.5px] font-normal text-muted-foreground">
            ⌘N
          </kbd>
        </button>
        <label className="flex h-[34px] items-center gap-2 rounded-[9px] px-2.5 text-[12.5px] text-muted-foreground transition-colors focus-within:bg-secondary/70 hover:bg-secondary/70">
          <Search size={14} className="shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
            className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* 视图 */}
        <nav aria-label="主导航" className="flex flex-col gap-[1px]">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = activeView === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                className={cn(
                  'flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] transition-colors',
                  active
                    ? 'bg-secondary font-medium text-foreground'
                    : 'text-foreground/80 hover:bg-secondary/70 hover:text-foreground'
                )}
              >
                <Icon size={15} className={active ? 'text-foreground' : 'text-muted-foreground'} />
                {item.label}
              </button>
            )
          })}
          <button
            type="button"
            onClick={onOpenIndex}
            className="flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] text-foreground/80 transition-colors hover:bg-secondary/70 hover:text-foreground"
          >
            <Database size={15} className="text-muted-foreground" />
            索引与记忆
            {indexedCount !== null && (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {indexedCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={onOpenDiagnostics}
            className="flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] text-foreground/80 transition-colors hover:bg-secondary/70 hover:text-foreground"
          >
            <Activity size={15} className="text-muted-foreground" />
            运行诊断
          </button>
        </nav>

        {/* 智能体 */}
        <div className="mt-5">
          <div className="mb-1 flex items-center justify-between px-2.5">
            <span className="text-[11px] font-medium text-muted-foreground">智能体</span>
            {onCreateBot && (
              <button
                type="button"
                title="新建智能体角色"
                onClick={onCreateBot}
                className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Plus size={13} />
              </button>
            )}
          </div>
          <div className="flex flex-col gap-[1px]">
            {bots.map((bot) => {
              const isSelected =
                bot.id === activeBotId ||
                (selectedConversationId !== null && bot.conversationId === selectedConversationId)
              return (
                <div
                  key={bot.id}
                  onClick={() => onSelectBot?.(bot)}
                  className={cn(
                    'group flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 transition-colors',
                    isSelected ? 'bg-secondary' : 'hover:bg-secondary/70'
                  )}
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-[7px] border border-border bg-background text-[13px] leading-none">
                    {bot.avatar || '🤖'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-foreground">
                        {bot.name}
                      </span>
                      {bot.isDefault && (
                        <span className="rounded border border-border px-1 text-[9px] leading-[14px] text-muted-foreground">
                          默认
                        </span>
                      )}
                    </div>
                    {bot.description && (
                      <div className="truncate text-[10.5px] text-muted-foreground">
                        {bot.description}
                      </div>
                    )}
                  </div>
                  {onEditBot && (
                    <button
                      type="button"
                      title="编辑伴侣设定"
                      onClick={(event) => {
                        event.stopPropagation()
                        onEditBot(bot)
                      }}
                      className="rounded p-1 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    >
                      编辑
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* 历史 */}
        <div className="mt-5">
          <div className="mb-1 px-2.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {query.trim() === '' ? '最近' : `搜索「${query.trim()}」`}
            </span>
          </div>
          {filtered.length === 0 && (
            <p className="m-0 px-2.5 py-1 text-[11.5px] text-muted-foreground">
              {query.trim() === '' ? '还没有历史会话' : '没有匹配的会话'}
            </p>
          )}
          {groupConversations(filtered).map((group) => (
            <div key={group.label} className="mt-2">
              <p className="mb-1 mt-0 px-2.5 text-[10.5px] text-muted-foreground/80">
                {group.label}
              </p>
              <div className="flex flex-col gap-[1px]">
                {group.items.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => onSelectConversation(conversation.id)}
                    className={cn(
                      'flex h-[30px] w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[12.5px] transition-colors',
                      conversation.id === selectedConversationId
                        ? 'bg-secondary font-medium text-foreground'
                        : 'text-foreground/75 hover:bg-secondary/70 hover:text-foreground'
                    )}
                  >
                    <span className="truncate">{conversation.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 状态与设置 */}
      <div className="shrink-0 border-t border-border px-2 py-2">
        <div className="flex items-center gap-2 px-2.5 py-1 text-[11px] text-muted-foreground">
          <span className={cn('size-1.5 shrink-0 rounded-full', runtime.dot)} />
          <span className="truncate">
            {runtime.text}
            {indexedCount !== null && ` · 索引 ${indexedCount} 份`}
          </span>
        </div>
        <button
          type="button"
          onClick={onSettings}
          className="flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] text-foreground/80 transition-colors hover:bg-secondary/70 hover:text-foreground"
        >
          <Settings size={15} className="text-muted-foreground" />
          设置
        </button>
      </div>
    </aside>
  )
}
