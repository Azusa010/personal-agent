import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = join(__dirname, '../../../../src/renderer/src')
const SIDEBAR_PATH = join(RENDERER_SRC, 'components/Sidebar.tsx')
const APP_PATH = join(RENDERER_SRC, 'App.tsx')

const sidebarSource = readFileSync(SIDEBAR_PATH, 'utf8')
const appSource = readFileSync(APP_PATH, 'utf8')

/** 取出 App.tsx 里 `<Sidebar ... />` 这段 props 文本，用于校验真实传参。 */
function extractSidebarJsx(source: string): string {
  const start = source.indexOf('<Sidebar')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('/>', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

/**
 * 侧栏只保留角色伴侣入口：跨角色的「最近」历史会话分区已下线。
 * 这里用源结构断言锁死，防止后续会话列表又被悄悄挂回来。
 */
describe('侧栏会话入口只走智能体伴侣', () => {
  it('扫描范围有效（防止路径写错导致空跑通过）', () => {
    expect(sidebarSource.length).toBeGreaterThan(2000)
    expect(appSource.length).toBeGreaterThan(2000)
  })

  it('侧栏不再渲染历史会话分区及其筛选逻辑', () => {
    const forbidden = [
      '最近',
      '历史会话',
      '搜索会话',
      'groupConversations',
      'dayKey',
      'onSelectConversation',
      'ConversationSummary',
      'conversation.title'
    ]
    const hits = forbidden.filter((token) => sidebarSource.includes(token))
    expect(hits).toEqual([])
  })

  it('侧栏保留角色伴侣入口与新建对话', () => {
    expect(sidebarSource).toContain('智能体')
    expect(sidebarSource).toContain('bots.map')
    expect(sidebarSource).toContain('onSelectBot')
    expect(sidebarSource).toContain('新对话')
    expect(sidebarSource).toContain('aria-label="主导航"')
  })

  it('App 不再向 Sidebar 传会话列表与跨角色选择回调', () => {
    const sidebarJsx = extractSidebarJsx(appSource)
    expect(sidebarJsx).not.toContain('conversations=')
    expect(sidebarJsx).not.toContain('onSelectConversation')
    // 反孤岛：角色入口必须仍被实际接线
    expect(sidebarJsx).toContain('bots={bots}')
    expect(sidebarJsx).toContain('onSelectBot={handleSelectBot}')
  })
})
