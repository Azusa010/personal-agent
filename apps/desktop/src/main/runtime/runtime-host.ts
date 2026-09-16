import { dirname, join } from 'node:path'
import { PythonSupervisor, RuntimeError } from './python-supervisor'
import { app } from 'electron/main'
import { is } from '@electron-toolkit/utils'
import { existsSync } from 'node:fs'
import { RUNTIME_ERROR_CODE } from './error-code'
import type { RuntimeState, RuntimeStatus } from '../../shared/ipc-contract'
import { executeHostTool, listVisibleCapabilities } from '../capabilities/host-executor'

export type { RuntimeState, RuntimeStatus }
let supervisor: PythonSupervisor | null = null
let state: RuntimeState = 'stopped'
let detail: string | undefined

/** 显式覆盖运行时命令：指向一个自带入口的可执行文件（通常是冻结产物 exe）。
 *  打包/开发两种布局之外的口子，冒烟与排障用它把 app 指到别的运行时上。 */
export const RUNTIME_ENV = 'PERSONAL_AGENT_RUNTIME'

/** 运行时启动参数：command/args 交给 spawn，cwd 是子进程工作目录。
 *  layout 只用于崩溃时的可读提示（哪种布局命中了）。 */
export interface RuntimeLaunch {
  command: string
  args: string[]
  cwd: string
  layout: string
}

/** 布局解析的全部输入。显式传参而不是直接读 app/process：
 *  这样三分支能被单测直接喂值覆盖，不必把 electron mock 成打包态。 */
export interface RuntimeLayoutInput {
  isPackaged: boolean
  /** app.getAppPath()：开发态指向 apps/desktop */
  appPath: string
  /** process.resourcesPath：打包后指向 <安装目录>/resources */
  resourcesPath: string
  /** PERSONAL_AGENT_RUNTIME，没设就是 undefined */
  override?: string
}

function resolveOverrideLaunch(command: string): RuntimeLaunch {
  return { command, args: [], cwd: dirname(command), layout: `${RUNTIME_ENV} 覆盖` }
}

/**
 * 打包布局：electron-builder 的 extraResources 把 PyInstaller 冻结产物
 * （services/agent-runtime/dist/personal_agent/）随安装包分发。
 */
function resolvePackagedLaunch(resourcesPath: string): RuntimeLaunch {
  const runtimeDir = join(resourcesPath, 'agent-runtime')
  const command = join(
    runtimeDir,
    process.platform === 'win32' ? 'personal_agent.exe' : 'personal_agent'
  )
  return {
    command,
    args: [],
    cwd: runtimeDir,
    layout: '打包布局'
  }
}

/** 开发布局：仓库里 uv 建的 venv，`python -m personal_agent` 跑源码。
 *  不走 `uv run` 是为了避开「Electron GUI 进程 PATH 与终端不同」这个坑。 */
function resolveDevLaunch(appPath: string): RuntimeLaunch {
  const repoRoot = join(appPath, '..', '..')
  const cwd = join(repoRoot, 'services', 'agent-runtime')
  const command = join(cwd, '.venv', 'Scripts', 'python.exe')
  return { command, args: ['-m', 'personal_agent'], cwd, layout: '开发布局（venv）' }
}

/** 优先级：显式覆盖 > 打包布局 > 开发布局。
 *  命令不存在时不在这里收场——调用方 existsSync 检查后落 crashed 并带出可读提示。 */
export function resolveRuntimeLaunch(input: RuntimeLayoutInput): RuntimeLaunch {
  if (input.override !== undefined && input.override !== '') {
    return resolveOverrideLaunch(input.override)
  }
  if (input.isPackaged) {
    return resolvePackagedLaunch(input.resourcesPath)
  }
  return resolveDevLaunch(input.appPath)
}

export function getRuntimeStatus(): RuntimeStatus {
  return detail ? { state, detail } : { state }
}

export async function startRuntime(): Promise<void> {
  if (supervisor) return // 避免重复spawn
  state = 'starting'
  detail = undefined

  const launch = resolveRuntimeLaunch({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    override: process.env[RUNTIME_ENV]
  })
  if (!existsSync(launch.command)) {
    state = 'crashed'
    detail = `找不到运行时（${launch.layout}）: ${launch.command}`
    return
  }

  supervisor = new PythonSupervisor({
    ...launch,
    hostHandler: executeHostTool,
    capabilities: listVisibleCapabilities()
  })
  supervisor.on('runtime.crashed', (info: { reason: string; detail: string }) => {
    state = 'crashed'
    detail = `runtime 崩溃 (${info.reason}: ${info.detail})`
  })
  // python 日志
  supervisor.on('stderr', (chunk: string) => {
    if (is.dev) process.stderr.write(`[python] ${chunk}`)
  })

  try {
    supervisor.start()
    const init = await supervisor.initialize()
    state = 'ready'
    detail = `已连接 ${init.server.name} v${init.server.version} (协议 ${init.protocolVersion})`
  } catch (err) {
    state = 'crashed'
    detail = err instanceof RuntimeError ? `${err.code}:${err.message}` : String(err)
    await supervisor.stop().catch(() => {})
    supervisor = null
  }
}

export async function stopRuntime(): Promise<void> {
  if (!supervisor) {
    state = 'stopped'
    detail = undefined
    return
  }
  await supervisor.stop().catch(() => {})
  supervisor = null
  state = 'stopped'
  detail = undefined
}

// opts 透传给 supervisor.request：agent.run_task 要跑完整个 Agent Loop，
export async function requestRuntime(
  method: string,
  params?: unknown,
  opts?: { timeoutMs?: number }
): Promise<unknown> {
  if (!supervisor) {
    throw new RuntimeError(RUNTIME_ERROR_CODE.NOT_STARTED, 'Python runtime 未启动')
  }
  return supervisor.request(method, params, opts)
}
