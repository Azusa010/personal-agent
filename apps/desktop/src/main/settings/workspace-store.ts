import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { toPosix } from '../capabilities/roots'

/**
 * workspace.json：工作区选择功能的持久化。
 *
 * 工作区是「智能体当前在哪干活」的旋钮（终端 cwd、技能发现根、相对路径基准、
 * 文件组织任务的默认落点），不是安全边界——写走批准卡片，读不设限。
 * bookmarks 只是「以前选过」的快捷切换书签，无任何授权语义。
 */

export interface WorkspaceState {
  /** 当前激活的工作区，正斜杠绝对路径 */
  current: string
  /** 历史工作区书签，最近选择在前；恒包含 current */
  bookmarks: string[]
}

export const WORKSPACE_FILE_NAME = 'workspace.json'
export const WORKSPACE_VERSION = 1
/** 智能体家目录：与 ~/.claude、~/.codex、~/.gemini 同构的点目录 */
export const SAKI_HOME_DIR_NAME = '.saki-bot'

export function defaultWorkspaceHome(): string {
  return toPosix(join(homedir(), SAKI_HOME_DIR_NAME))
}

/** 所有落盘/比较前统一过这里：绝对化 + 正斜杠，与 wire/db 的路径写法同源 */
export function normalizeWorkspaceDir(dir: string): string {
  return toPosix(resolve(dir))
}

export function loadWorkspaceState(filePath: string): WorkspaceState | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }

  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null

  const record = stored as Record<string, unknown>
  if (record.version !== WORKSPACE_VERSION) return null
  if (typeof record.current !== 'string' || record.current.trim() === '') return null
  if (!Array.isArray(record.bookmarks)) return null

  const bookmarks = record.bookmarks.filter((b): b is string => typeof b === 'string')
  return { current: normalizeWorkspaceDir(record.current), bookmarks }
}

export function saveWorkspaceState(filePath: string, state: WorkspaceState): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(
    filePath,
    `${JSON.stringify({ version: WORKSPACE_VERSION, ...state }, null, 2)}\n`,
    'utf8'
  )
}

/** 启动时调用：文件缺失/损坏则回落家目录（首次即创建 ~/.saki-bot），并把 current 物理建出来 */
export function ensureWorkspaceState(filePath: string): WorkspaceState {
  const existing = loadWorkspaceState(filePath)
  const home = defaultWorkspaceHome()
  if (existing === null) {
    const state: WorkspaceState = { current: home, bookmarks: [home] }
    mkdirSync(home, { recursive: true })
    saveWorkspaceState(filePath, state)
    return state
  }
  if (!existing.bookmarks.includes(existing.current)) {
    existing.bookmarks = [existing.current, ...existing.bookmarks]
  }
  try {
    mkdirSync(existing.current, { recursive: true })
  } catch {
    // current 建不出来（如网络盘掉线）：不阻塞启动，工具链会在用时各自报错
  }
  return existing
}

/** 书签去重 + 置顶。选择新工作区与补登记都走这里 */
export function withBookmark(state: WorkspaceState, dir: string): WorkspaceState {
  const normalized = normalizeWorkspaceDir(dir)
  return {
    current: normalized,
    bookmarks: [normalized, ...state.bookmarks.filter((b) => b !== normalized)]
  }
}
