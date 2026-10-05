import { PersonalAgentLogo } from './PersonalAgentLogo'
import { useEffect, useState, type CSSProperties } from 'react'

type ThemePalette = 'classic' | 'paper-warm' | 'paper-dark'

const THEME_STORAGE_KEY = 'pa_theme_palette'

interface ThemeOption {
  id: ThemePalette
  label: string
  dot: string
}

const THEMES: ThemeOption[] = [
  { id: 'classic', label: '经典青绿', dot: 'bg-[#0f9d8f]' },
  { id: 'paper-warm', label: '象牙纸', dot: 'bg-[#c45535]' },
  { id: 'paper-dark', label: '暗炭纸', dot: 'bg-[#da7756]' }
]

function getInitialTheme(): ThemePalette {
  if (typeof window === 'undefined') return 'classic'
  const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemePalette | null
  if (saved === 'paper-warm' || saved === 'paper-dark' || saved === 'classic') {
    return saved
  }
  return 'classic'
}

/**
 * 自绘窗口顶栏(原生标题栏已在主进程隐藏): 纸感底、品牌区、全宽拖拽与主题切换。
 * Windows 上系统窗控钮由 titleBarOverlay 绘制;
 * env(titlebar-area-*) 让拖拽区精确避开窗控钮, 不支持的端回退为全宽。
 */
export function TitleBar(): React.JSX.Element {
  const [currentTheme, setCurrentTheme] = useState<ThemePalette>(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme)
    void window.personalAgent?.setTitleBarTheme?.(currentTheme)
  }, [currentTheme])

  const handleSelectTheme = (theme: ThemePalette): void => {
    setCurrentTheme(theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }

  return (
    <header
      className="flex h-10 shrink-0 select-none items-center justify-between border-b border-border bg-secondary px-4 transition-colors duration-200"
      style={
        {
          WebkitAppRegion: 'drag',
          width: 'env(titlebar-area-width, 100%)',
          marginLeft: 'env(titlebar-area-x, 0px)'
        } as CSSProperties
      }
    >
      <div className="flex items-center gap-2.5">
        <PersonalAgentLogo size={20} className="shrink-0" />
        <span className="font-serif text-[13px] font-bold tracking-wide text-foreground">
          PersonalAgent
        </span>
        <span className="text-[11px] text-muted-foreground">本地文档工作台</span>
      </div>

      {/* 主题选择器: segmented pills, 响应式切换且不拦截窗口拖拽 */}
      <div
        className="flex items-center gap-1 rounded-md border border-border/80 bg-background/70 p-0.5 shadow-2xs"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        {THEMES.map((theme) => {
          const isActive = currentTheme === theme.id
          return (
            <button
              key={theme.id}
              type="button"
              onClick={() => handleSelectTheme(theme.id)}
              className={`flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors ${
                isActive
                  ? 'bg-primary text-primary-foreground shadow-2xs'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}
              title={`切换至 ${theme.label}`}
            >
              <span
                className={`size-1.5 rounded-full ${theme.dot} ${isActive ? 'ring-1 ring-white/50' : 'opacity-70'}`}
              />
              <span>{theme.label}</span>
            </button>
          )
        })}
      </div>
    </header>
  )
}
