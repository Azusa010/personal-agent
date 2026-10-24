import type {
  ChooseWorkspaceResult,
  WorkspaceMutateResult,
  WorkspaceView
} from '../../shared/ipc-contract'

import {
  defaultWorkspaceHome,
  loadWorkspaceState,
  normalizeWorkspaceDir,
  saveWorkspaceState,
  withBookmark,
  type WorkspaceState
} from './workspace-store'

/**
 * 工作区 IPC 的纯逻辑层。真实的对话框、任务查询与 runtime 重启由 index.ts 注入，
 * 与 settings-ipc 的「纯函数 + 注入 deps」同一套模式。
 */
export interface WorkspaceIpcDeps {
  filePath: string
  /** 当前是否挂着没跑完的任务（running / waiting_permission），有则拒绝切换 */
  hasActiveTask(): boolean
  /** 原生文件夹选择器；用户取消返回 null */
  pickDir(): Promise<string | null>
  /** 切换生效后重启 Python runtime（env 是 spawn 时注入的，不重启就是旧值） */
  restartRuntime(): Promise<unknown>
}

export function getWorkspaceView(deps: WorkspaceIpcDeps): WorkspaceView {
  const state = loadWorkspaceState(deps.filePath)
  return {
    current: state?.current ?? '',
    home: defaultWorkspaceHome(),
    bookmarks: state?.bookmarks ?? []
  }
}

export async function chooseWorkspace(deps: WorkspaceIpcDeps): Promise<ChooseWorkspaceResult> {
  const state = loadWorkspaceState(deps.filePath)
  if (state === null) {
    return { ok: false, code: 'WORKSPACE_STATE_MISSING', message: '工作区状态文件缺失' }
  }

  if (deps.hasActiveTask()) {
    return {
      ok: false,
      code: 'TASK_RUNNING',
      message: '有任务正在运行，等它结束后再切换工作区'
    }
  }

  const picked = await deps.pickDir()
  if (picked === null) {
    return { ok: true, view: toView(state), changed: false }
  }

  const next = withBookmark(state, picked)
  try {
    saveWorkspaceState(deps.filePath, next)
  } catch (e) {
    return {
      ok: false,
      code: 'WORKSPACE_SAVE_FAILED',
      message: e instanceof Error ? e.message : String(e)
    }
  }
  process.env.PERSONAL_AGENT_WORKSPACE_DIR = next.current
  await deps.restartRuntime()
  return { ok: true, view: toView(next), changed: true }
}

export function removeWorkspaceBookmark(
  deps: WorkspaceIpcDeps,
  rawDir: unknown
): WorkspaceMutateResult {
  if (typeof rawDir !== 'string' || rawDir.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'dir 必须是非空字符串' }
  }
  const state = loadWorkspaceState(deps.filePath)
  if (state === null) {
    return { ok: false, code: 'WORKSPACE_STATE_MISSING', message: '工作区状态文件缺失' }
  }
  const dir = normalizeWorkspaceDir(rawDir)
  if (dir === state.current) {
    return {
      ok: false,
      code: 'CURRENT_BOOKMARK',
      message: '当前工作区不能删除，先切换到别的工作区'
    }
  }
  const next: WorkspaceState = { ...state, bookmarks: state.bookmarks.filter((b) => b !== dir) }
  try {
    saveWorkspaceState(deps.filePath, next)
  } catch (e) {
    return {
      ok: false,
      code: 'WORKSPACE_SAVE_FAILED',
      message: e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: true, view: toView(next) }
}

/** 书签直切：不走选择器，其余语义与 chooseWorkspace 相同（running 拒切 → 存盘 → env → 重启） */
export async function switchWorkspace(
  deps: WorkspaceIpcDeps,
  rawDir: unknown
): Promise<ChooseWorkspaceResult> {
  const state = loadWorkspaceState(deps.filePath)
  if (state === null) {
    return { ok: false, code: 'WORKSPACE_STATE_MISSING', message: '工作区状态文件缺失' }
  }
  if (typeof rawDir !== 'string' || rawDir.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'dir 必须是非空字符串' }
  }
  const dir = normalizeWorkspaceDir(rawDir)
  if (dir === state.current) {
    return { ok: true, view: toView(state), changed: false }
  }
  if (deps.hasActiveTask()) {
    return {
      ok: false,
      code: 'TASK_RUNNING',
      message: '有任务正在运行，等它结束后再切换工作区'
    }
  }
  const next = withBookmark(state, dir)
  try {
    saveWorkspaceState(deps.filePath, next)
  } catch (e) {
    return {
      ok: false,
      code: 'WORKSPACE_SAVE_FAILED',
      message: e instanceof Error ? e.message : String(e)
    }
  }
  process.env.PERSONAL_AGENT_WORKSPACE_DIR = next.current
  await deps.restartRuntime()
  return { ok: true, view: toView(next), changed: true }
}

function toView(state: WorkspaceState): WorkspaceView {
  return { current: state.current, home: defaultWorkspaceHome(), bookmarks: state.bookmarks }
}
