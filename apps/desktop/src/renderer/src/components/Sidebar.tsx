import { Activity, Edit2, FolderCog, MessageSquare, Plus, Settings, Zap } from 'lucide-react'
import type { BotView, ConversationSummary, RuntimeStatus } from '../../../shared/ipc-contract'
import { cn } from '@renderer/lib/utils'

export interface SidebarProps {
  conversations: ConversationSummary[]
  selectedConversationId: string | null
  runtimeStatus: RuntimeStatus | null
  indexedCount: number | null
  activeView: 'chat' | 'workflows'
  bots?: BotView[]
  activeBotId?: string | null
  onSelectView: (view: 'chat' | 'workflows') => void
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
  const statusText =
    indexedCount === null ? runtime.text : `${runtime.text} · 索引 ${indexedCount} 份 PDF`

  // 过滤掉已作为专有智能体伴侣常驻会话的记录，避免历史列表中产生重复项
  const botConvIds = new Set(bots.map((b) => b.conversationId).filter(Boolean))
  const filteredConversations = conversations.filter((c) => !botConvIds.has(c.id))

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-secondary">
      <div className="px-4 pt-4">
        {/* 顶部主工作区切换标签 */}
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--paper-warm)] p-1 text-[12px] font-medium">
          <button
            type="button"
            onClick={() => onSelectView('chat')}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md py-1.5 transition-colors',
              activeView === 'chat'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <MessageSquare size={14} />
            <span>对话</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectView('workflows')}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md py-1.5 transition-colors',
              activeView === 'workflows'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Zap size={14} />
            <span>工作流</span>
          </button>
        </div>

        {activeView === 'chat' && (
          <button
            type="button"
            onClick={onNewChat}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Plus size={16} />
            新对话
          </button>
        )}
      </div>

      {activeView === 'chat' ? (
        <nav className="mt-3 flex-1 overflow-y-auto px-3 space-y-4" aria-label="对话导航">
          {/* 智能体伴侣专区 (Dots / Grok Bot 范式) */}
          {bots.length > 0 && (
            <div>
              <div className="flex items-center justify-between px-2 mb-1.5">
                <span className="text-[11px] font-semibold tracking-wider text-muted-foreground">
                  智能体伴侣
                </span>
                {onCreateBot && (
                  <button
                    type="button"
                    title="新建智能体角色"
                    onClick={onCreateBot}
                    className="flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary/80 px-1 py-0.5 rounded hover:bg-primary/10 transition-colors"
                  >
                    <Plus size={12} />
                    <span>新建</span>
                  </button>
                )}
              </div>
              <div className="space-y-1">
                {bots.map((bot) => {
                  const isSelected =
                    bot.id === activeBotId ||
                    (selectedConversationId !== null && bot.conversationId === selectedConversationId)
                  return (
                    <div
                      key={bot.id}
                      onClick={() => onSelectBot?.(bot)}
                      className={cn(
                        'group relative flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13px] cursor-pointer transition-colors',
                        isSelected
                          ? 'border border-border bg-card text-foreground shadow-xs font-medium'
                          : 'text-muted-foreground hover:bg-card/60 hover:text-foreground border border-transparent'
                      )}
                    >
                      <span className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-secondary text-base">
                        {bot.avatar || '🤖'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate">{bot.name}</span>
                          {bot.isDefault && (
                            <span className="rounded bg-primary/10 px-1 py-0.2 text-[9px] font-medium text-primary">
                              默认
                            </span>
                          )}
                        </div>
                        {bot.description && (
                          <div className="truncate text-[10px] text-muted-foreground font-normal">
                            {bot.description}
                          </div>
                        )}
                      </div>
                      {onEditBot && (
                        <button
                          type="button"
                          title="编辑伴侣设定"
                          onClick={(e) => {
                            e.stopPropagation()
                            onEditBot(bot)
                          }}
                          className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-opacity"
                        >
                          <Edit2 size={12} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 独立历史会话列表 */}
          <div>
            <div className="flex items-center justify-between px-2 mb-1.5">
              <span className="text-[11px] font-semibold tracking-wider text-muted-foreground">
                历史会话
              </span>
            </div>
            {filteredConversations.length === 0 && (
              <p className="px-2 text-[11px] text-muted-foreground">还没有独立历史会话</p>
            )}
            {groupConversations(filteredConversations).map((group) => (
              <div key={group.label}>
                <p className="mb-2 mt-3 px-2 text-[11px] font-medium text-muted-foreground first:mt-0">
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
                          ? 'border border-border bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-card/70 hover:text-foreground'
                      )}
                    >
                      <MessageSquare size={14} className="shrink-0" />
                      <span className="truncate">{conversation.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>
      ) : (
        <nav className="mt-4 flex-1 overflow-y-auto px-3" aria-label="工作流列表">
          <p className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">可用工作流</p>
          <div className="space-y-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md bg-secondary px-2.5 py-2 text-left text-[13px] text-foreground"
            >
              <Zap size={14} className="shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">PDF 自动归档整理</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  Golden Path 标准流程
                </div>
              </div>
            </button>
          </div>
        </nav>
      )}

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
            className="rounded p-1.5 text-muted-foreground hover:bg-card/80 hover:text-foreground"
          >
            <FolderCog size={16} />
          </button>
          <button
            type="button"
            title="运行诊断"
            aria-label="运行诊断"
            onClick={onOpenDiagnostics}
            className="rounded p-1.5 text-muted-foreground hover:bg-card/80 hover:text-foreground"
          >
            <Activity size={16} />
          </button>
          <button
            type="button"
            title="设置"
            aria-label="设置"
            onClick={onSettings}
            className="rounded p-1.5 text-muted-foreground hover:bg-card/80 hover:text-foreground"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}
