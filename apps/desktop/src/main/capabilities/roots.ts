import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const ROOT_ENV: Record<string, string> = {
  downloads: 'PERSONAL_AGENT_DOWNLOADS_DIR',
  workspace: 'PERSONAL_AGENT_WORKSPACE_DIR'
}

// 反斜杠 -> 正斜杠
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

// 格式化修改时间
export function formatModifiedAt(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function resolveRoot(rootId: string): string {
  const envName = ROOT_ENV[rootId]
  if (envName === undefined) {
    throw new Error(`未知 rootId: ${rootId}`)
  }
  const fromEnv = process.env[envName]
  let base: string
  if (fromEnv) {
    base = fromEnv
  } else if (rootId === 'workspace') {
    base = process.cwd()
  } else {
    base = join(homedir(), 'Downloads')
  }
  return toPosix(resolve(base))
}

/** 沙箱 Python 解析:env 显式覆盖 → 仓库 venv 的真解释器 → null(回退 PATH 裸命令)。
 *  Windows 上裸 `python` 常命中最装 stub(非交互下静默退出 9009),且 GUI 进程的
 *  PATH 与终端不同——venv 布局与 runtime-host 保持一致。cwd 锚定 apps/desktop
 *  (vitest 与 electron-vite dev 的工作目录);打包布局下 venv 不存在,自然回退。 */
export function resolveSandboxPython(): string | null {
  const override = process.env.PERSONAL_AGENT_SANDBOX_PYTHON
  if (override !== undefined && override !== '') return override

  const venvPython = join(
    process.cwd(),
    '..',
    '..',
    'services',
    'agent-runtime',
    '.venv',
    process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')
  )
  return existsSync(venvPython) ? venvPython : null
}

/** 沙箱解释器所在目录,供把裸 `python` 之类的命令导向真解释器(PATH 前置)。 */
export function resolveSandboxPythonBinDir(): string | null {
  const python = resolveSandboxPython()
  return python === null ? null : dirname(python)
}
