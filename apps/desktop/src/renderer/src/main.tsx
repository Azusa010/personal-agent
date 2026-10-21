import './assets/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import DesignLab from './design-lab/DesignLab'
import { installRendererErrorHooks } from './lib/report-renderer-error'
import { applyThemeToRoot } from './lib/theme'
import type { EffectiveTheme } from '../../shared/theme'

const queryClient = new QueryClient()

installRendererErrorHooks()

/* #design → 设计实验室(温暖纸感交互原型),其余 → 正常应用。
   入口在挂载时判定一次即可,原型页不依赖 preload API,浏览器直接打开也能看。 */
const isDesignLab = window.location.hash === '#design'

/* 首帧主题：必须在 render 之前落 class，否则 React 首屏会先按浅色画一遍。
   正常应用从 preload 拿主进程注入的同步值；原型页与纯浏览器调试回落到系统偏好。 */
if (!isDesignLab) {
  const bridge: { initialTheme?: EffectiveTheme } | undefined = window.personalAgent
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const initialTheme = bridge?.initialTheme ?? (prefersDark ? 'dark' : 'light')
  applyThemeToRoot(document.documentElement, initialTheme)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isDesignLab ? <DesignLab /> : <App />}
    </QueryClientProvider>
  </StrictMode>
)
