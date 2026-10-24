import { Activity, Database, MessageSquare, Plus, Settings, Zap } from 'lucide-react'
import type { BotView, RuntimeStatus, WorkspaceView } from '../../../shared/ipc-contract'
import { cn } from '@renderer/lib/utils'
import { WorkspaceChip } from './WorkspaceChip'

export type AppView = 'chat' | 'workflows' | 'settings'

export interface SidebarProps {
  selectedConversationId: string | null
  runtimeStatus: RuntimeStatus | null
  indexedCount: number | null
  activeView: AppView
  bots?: BotView[]
  activeBotId?: string | null
  workspace?: WorkspaceView | null
  onSelectView: (view: AppView) => void
  onSelectBot?: (bot: BotView) => void
  onCreateBot?: () => void
  onEditBot?: (bot: BotView) => void
  onNewChat: () => void
  onOpenIndex: () => void
  onOpenDiagnostics: () => void
  onSettings: () => void
  onSwitchWorkspace?: (dir: string) => void
  onChooseWorkspace?: () => void
  onRemoveWorkspaceBookmark?: (dir: string) => void
}

const RUNTIME_LABELS: Record<RuntimeStatus['state'], { text: string; dot: string }> = {
  ready: { text: '运行时就绪', dot: 'bg-success' },
  starting: { text: '运行时启动中', dot: 'bg-warning' },
  crashed: { text: '运行时崩溃', dot: 'bg-destructive' },
  stopped: { text: '运行时未启动', dot: 'bg-muted-foreground' }
}

export function Sidebar({
  selectedConversationId,
  runtimeStatus,
  indexedCount,
  activeView,
  bots = [],
  activeBotId,
  workspace = null,
  onSelectView,
  onSelectBot,
  onCreateBot,
  onEditBot,
  onNewChat,
  onOpenIndex,
  onOpenDiagnostics,
  onSettings,
  onSwitchWorkspace,
  onChooseWorkspace,
  onRemoveWorkspaceBookmark
}: SidebarProps): React.JSX.Element {
  const runtime = RUNTIME_LABELS[runtimeStatus?.state ?? 'stopped']

  const navItems = [
    { id: 'chat' as const, label: '对话', icon: MessageSquare },
    { id: 'workflows' as const, label: '工作流', icon: Zap }
  ]

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-background">
      {/* 会话入口统一收敛到「智能体」分区，这里只留新建 */}
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
        {onSwitchWorkspace && onChooseWorkspace && onRemoveWorkspaceBookmark && (
          <WorkspaceChip
            workspace={workspace}
            onSwitch={onSwitchWorkspace}
            onChoose={onChooseWorkspace}
            onRemoveBookmark={onRemoveWorkspaceBookmark}
          />
        )}
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
