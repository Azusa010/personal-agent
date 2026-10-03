import './assets/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import DesignLab from './design-lab/DesignLab'

const queryClient = new QueryClient()

/* #design → 设计实验室(温暖纸感交互原型),其余 → 正常应用。
   入口在挂载时判定一次即可,原型页不依赖 preload API,浏览器直接打开也能看。 */
const isDesignLab = window.location.hash === '#design'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isDesignLab ? <DesignLab /> : <App />}
    </QueryClientProvider>
  </StrictMode>
)
