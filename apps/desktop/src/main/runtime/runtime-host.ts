import { dirname, join } from 'node:path'
import { PythonSupervisor, RuntimeError } from './python-supervisor'
import { app, safeStorage } from 'electron/main'
import { is } from '@electron-toolkit/utils'
import { existsSync } from 'node:fs'
import { RUNTIME_ERROR_CODE } from './error-code'
import type { RuntimeState, RuntimeStatus } from '../../shared/ipc-contract'
import { executeHostTool, listVisibleCapabilities } from '../capabilities/host-executor'
import {
  SETTINGS_FILE_NAME,
  buildRuntimeEnv,
  loadModelSettings,
  saveModelSettings,
  type ModelSettings,
  type ModelSettingsStore,
  type SecretCodec
} from '../settings/model-settings'

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

/** 模型设置文件的位置：userData 跟用户账号走（重装不丢），不跟安装目录走。 */
export function resolveSettingsFilePath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE_NAME)
}

/** 真实密钥库端口。safeStorage 延迟取用而不是模块顶层解构：
 *  单测 mock 的 'electron' 里只有 app，顶层解构会在 import 期就炸。 */
function systemSecretCodec(): SecretCodec {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (encrypted: string) => safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }
}

/** 设置面板与运行时启动共用的存储实现：同一个文件、同一套加密。
 *  load 出意外（文件系统、密钥库）时收成 null——设置读不出来只是回到「未配置」，
 *  不能让一个坏文件挡住整个 app。 */
export function createModelSettingsStore(): ModelSettingsStore {
  return {
    load: (): ModelSettings | null => {
      try {
        return loadModelSettings({
          filePath: resolveSettingsFilePath(),
          codec: systemSecretCodec()
        })
      } catch (err) {
        console.error('[settings] 读取模型设置失败，按未配置继续', err)
        return null
      }
    },
    save: (settings: ModelSettings): void => {
      saveModelSettings(settings, {
        filePath: resolveSettingsFilePath(),
        codec: systemSecretCodec()
      })
    }
  }
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
    // 显式传 env：设置面板里存过的 OPENAI_* 在这里合进继承环境（TASK-030）。
    // 不传的话子进程只继承 Electron 自己的环境，面板里存什么都不会生效。
    env: buildRuntimeEnv(process.env, createModelSettingsStore().load()),
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

/** 重启运行时让新设置生效。Python 启动时读一次 OPENAI_MODEL，改配置只能靠重启；
 *  有任务在跑就不动它（返回 restarted=false），调用方把生效推到下次启动。 */
export async function restartRuntime(): Promise<{ restarted: boolean }> {
  if (supervisor !== null && supervisor.busy) return { restarted: false }
  await stopRuntime()
  await startRuntime()
  return { restarted: true }
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
