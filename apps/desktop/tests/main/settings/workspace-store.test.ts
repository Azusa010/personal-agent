import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ensureWorkspaceState,
  loadWorkspaceState,
  normalizeWorkspaceDir,
  saveWorkspaceState,
  withBookmark,
  WORKSPACE_VERSION
} from '../../../src/main/settings/workspace-store'

let dir: string

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined as unknown as string
  }
})

async function tempFile(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'pa-ws-store-'))
  return join(dir, 'workspace.json')
}

describe('workspace-store', () => {
  it('文件缺失 -> ensure 落默认状态并物理建出书签目录', async () => {
    const file = await tempFile()
    const state = ensureWorkspaceState(file)

    expect(state.current).toContain('.saki-bot')
    expect(state.bookmarks).toEqual([state.current])

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(onDisk['version']).toBe(WORKSPACE_VERSION)
  })

  it('损坏的 JSON / 版本不匹配 -> 视为缺失，重置默认', async () => {
    const file = await tempFile()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{oops', 'utf8')
    expect(ensureWorkspaceState(file).current).toContain('.saki-bot')

    writeFileSync(file, JSON.stringify({ version: 999, current: 'x', bookmarks: [] }), 'utf8')
    expect(ensureWorkspaceState(file).current).toContain('.saki-bot')
  })

  it('save -> load 往返一致，路径统一成正斜杠绝对路径', async () => {
    const file = await tempFile()
    saveWorkspaceState(file, withBookmark({ current: 'x', bookmarks: [] }, dir))

    const state = loadWorkspaceState(file)
    expect(state?.current).toBe(normalizeWorkspaceDir(dir))
    expect(state?.bookmarks).toEqual([normalizeWorkspaceDir(dir)])
  })

  it('ensure 补登记缺失的 current 书签，且不重复', async () => {
    const file = await tempFile()
    saveWorkspaceState(file, { current: dir, bookmarks: [] })

    const state = ensureWorkspaceState(file)
    expect(state.bookmarks).toEqual([normalizeWorkspaceDir(dir)])
  })

  it('withBookmark 置顶去重', async () => {
    const state = withBookmark({ current: 'b', bookmarks: ['a', 'b', 'c'] }, 'c')
    expect(state.current).toBe(normalizeWorkspaceDir('c'))
    expect(state.bookmarks[0]).toBe(normalizeWorkspaceDir('c'))
    expect(state.bookmarks.filter((b) => b === normalizeWorkspaceDir('c'))).toHaveLength(1)
  })
})
