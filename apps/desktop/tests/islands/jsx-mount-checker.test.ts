import { describe, expect, it } from 'vitest'
import { findUnmountedJsxComponents } from '../../../../scripts/islands/jsx-mount-checker'

describe('findUnmountedJsxComponents (JSX 孤岛挂载检测器)', () => {
  it('应当准确识别被 import 但在 JSX 树中从未挂载渲染的组件', () => {
    const code = `
      import React from 'react'
      import { Button } from './components/ui/button'
      import { Table } from './components/ui/table'

      export function App() {
        return (
          <div className="container">
            <Button>点击我</Button>
          </div>
        )
      }
    `
    const result = findUnmountedJsxComponents(code, 'src/renderer/src/App.tsx')

    expect(result.filePath).toBe('src/renderer/src/App.tsx')
    expect(result.unmounted).toHaveLength(1)
    expect(result.unmounted[0].name).toBe('Table')
    expect(result.unmounted[0].source).toBe('./components/ui/table')
  })

  it('当所有引入的组件都以自闭合或开闭标签挂载时，应判定无孤岛', () => {
    const code = `
      import { Header } from './components/Header'
      import { Footer } from './components/Footer'

      export function Page() {
        return (
          <Header>
            <Footer />
          </Header>
        )
      }
    `
    const result = findUnmountedJsxComponents(code, 'src/renderer/src/Page.tsx')
    expect(result.unmounted).toHaveLength(0)
  })

  it('应当识别形如 <Dialog.Content /> 的复合组件，并将根对象 Dialog 视为已挂载', () => {
    const code = `
      import { Dialog } from './components/ui/dialog'
      import { Drawer } from './components/ui/drawer'

      export function Modal() {
        return (
          <Dialog.Root>
            <Dialog.Content>弹窗内容</Dialog.Content>
          </Dialog.Root>
        )
      }
    `
    const result = findUnmountedJsxComponents(code, 'src/renderer/src/Modal.tsx')
    expect(result.unmounted).toHaveLength(1)
    expect(result.unmounted[0].name).toBe('Drawer')
    expect(result.unmounted[0].source).toBe('./components/ui/drawer')
  })

  it('应当自动忽略小写开头的工具函数与外部三方库（非本地导入）', () => {
    const code = `
      import { useState, useEffect } from 'react'
      import { cn } from './lib/utils'
      import { LucideIcon } from 'lucide-react'

      export function MyComponent() {
        const [open, setOpen] = useState(false)
        return <div className={cn('box', open && 'open')}>内容</div>
      }
    `
    const result = findUnmountedJsxComponents(code, 'src/renderer/src/MyComponent.tsx')
    expect(result.unmounted).toHaveLength(0)
  })

  it('应当同时支持默认导入 (default import) 与命名导入', () => {
    const code = `
      import Composer from './components/Composer'
      import Sidebar from './components/Sidebar'

      export function MainLayout() {
        return <Composer />
      }
    `
    const result = findUnmountedJsxComponents(code, 'src/renderer/src/MainLayout.tsx')
    expect(result.unmounted).toHaveLength(1)
    expect(result.unmounted[0].name).toBe('Sidebar')
    expect(result.unmounted[0].source).toBe('./components/Sidebar')
  })

  it('当组件仅被 console.log 或赋值给普通变量（但未在 JSX 中挂载）时，依然判定为孤岛', () => {
    const code = `
      import { Card } from './components/ui/card'
      import { Badge } from './components/ui/badge'

      export function Display() {
        console.log(Card)
        const myComp = Card
        return <div><Badge /></div>
      }
    `
    const result = findUnmountedJsxComponents(code, 'src/renderer/src/Display.tsx')
    expect(result.unmounted).toHaveLength(1)
    expect(result.unmounted[0].name).toBe('Card')
  })

  it('应当自动忽略全大写常量或包含下划线的枚举常量（如 PERMISSION_STATE_LABELS）', () => {
    const code = `
      import { PERMISSION_STATE_LABELS, MAX_TIMEOUT } from '../view-model'
      import { Button } from './ui/button'

      export function Dialog() {
        return <Button>{PERMISSION_STATE_LABELS['test']}</Button>
      }
    `
    const result = findUnmountedJsxComponents(code, 'src/renderer/src/Dialog.tsx')
    expect(result.unmounted).toHaveLength(0)
  })
})
