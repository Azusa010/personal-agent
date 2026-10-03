import { PersonalAgentLogo } from './PersonalAgentLogo'
import type { CSSProperties } from 'react'

/**
 * 自绘窗口顶栏(原生标题栏已在主进程隐藏):纸感底、品牌区、全宽拖拽。
 * Windows 上系统窗控钮由 titleBarOverlay 绘制,配色与这里一致(见 main/index.ts);
 * env(titlebar-area-*) 让拖拽区精确避开窗控钮,不支持的端回退为全宽。
 */
export function TitleBar(): React.JSX.Element {
  return (
    <header
      className="flex h-10 shrink-0 select-none items-center gap-2.5 border-b border-border bg-[#f4f0e7] pl-4"
      style={
        {
          WebkitAppRegion: 'drag',
          width: 'env(titlebar-area-width, 100%)',
          marginLeft: 'env(titlebar-area-x, 0px)'
        } as CSSProperties
      }
    >
      <PersonalAgentLogo size={20} className="shrink-0" />
      <span className="font-serif text-[13px] font-bold tracking-wide text-foreground">
        PersonalAgent
      </span>
      <span className="text-[11px] text-muted-foreground">本地文档工作台</span>
    </header>
  )
}
