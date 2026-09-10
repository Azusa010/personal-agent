import { join } from 'node:path'
import { PythonSupervisor, RuntimeError } from './python-supervisor'
import { app } from 'electron/main'
import { is } from '@electron-toolkit/utils'
import { existsSync } from 'node:fs'
import { RUNTIME_ERROR_CODE } from './error-code'
import type { RuntimeState, RuntimeStatus } from '../../shared/ipc-contract'
import { executeHostTool } from '../capabilities/host-executor'

export type { RuntimeState, RuntimeStatus }
let supervisor: PythonSupervisor | null = null
let state: RuntimeState = 'stopped'
let detail: string | undefined

function resolveRuntimeLaunch(): { command: string; args: string[]; cwd: string } {
  const repoRoot = join(app.getAppPath(), '..', '..')
  const cwd = join(repoRoot, 'services', 'agent-runtime')
  const command = join(cwd, '.venv', 'Scripts', 'python.exe')
  return { command, args: ['-m', 'personal_agent'], cwd }
}

export function getRuntimeStatus(): RuntimeStatus {
  return detail ? { state, detail } : { state }
}

export async function startRuntime(): Promise<void> {
  if (supervisor) return // 避免重复spawn
  state = 'starting'
  detail = undefined

  const launch = resolveRuntimeLaunch()
  if (!existsSync(launch.command)) {
    state = 'crashed'
    detail = `找不到 venv python: ${launch.command}`
    return
  }

  supervisor = new PythonSupervisor({ ...launch, hostHandler: executeHostTool })
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

export async function requestRuntime(method: string, params?: unknown): Promise<unknown> {
  if (!supervisor) {
    throw new RuntimeError(RUNTIME_ERROR_CODE.NOT_STARTED, 'Python runtime 未启动')
  }
  return supervisor.request(method, params)
}
