import { PersonalAgentLogo } from './PersonalAgentLogo'
import type { CSSProperties } from 'react'

/**
 * 自绘窗口顶栏（原生标题栏已在主进程隐藏）：白底 + 一条发丝分隔线，
 * 只保留品牌与「本地」标记。旧稿的三套纸感主题已随设计语言一并移除，
 * 主题切换交给系统（未来的暗色只需在 app.css 里补一套 .dark token）。
 * Windows 上的窗控钮由 titleBarOverlay 绘制，env(titlebar-area-*) 让拖拽区避开它们。
 */
export function TitleBar(): React.JSX.Element {
  return (
    <header
      className="flex h-9 shrink-0 select-none items-center gap-2.5 border-b border-border bg-background px-4"
      style={
        {
          WebkitAppRegion: 'drag',
          width: 'env(titlebar-area-width, 100%)',
          marginLeft: 'env(titlebar-area-x, 0px)'
        } as CSSProperties
      }
    >
      <PersonalAgentLogo size={17} className="shrink-0" />
      <span className="text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
        Personal Agent
      </span>
      <span className="rounded-full border border-border px-1.5 py-[1px] text-[9.5px] font-medium text-muted-foreground">
        本地
      </span>
    </header>
  )
}
