/**
 * 运行时布局解析的三条分支（TASK-029）。
 *
 * 这是「打包后 app 还起不起得来」的第一道门：解析错了 command 就指不到东西，
 * startRuntime 只能落 crashed。三分支的期望值都在这里钉死——
 * 打包布局那条是陪练点，主人填完 resolvePackagedLaunch 之前它是红的。
 *
 * electron 只被 import 到，不起真实例：解析函数是参数化的纯函数，
 * isPackaged / appPath / resourcesPath 全部显式喂值。
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const FAKE_APP = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: (): string => ''
}))
vi.mock('electron', () => ({ app: FAKE_APP }))
vi.mock('electron/main', () => ({ app: FAKE_APP }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { resolveRuntimeLaunch, RUNTIME_ENV } from './runtime-host'

// 用 join 拼期望值，别写字面量反斜杠：测试跟随平台，命令侧也一样拼。
const APP_PATH = join('C:', 'repo', 'apps', 'desktop')
const RESOURCES = join('C:', 'app', 'resources')

describe('resolveRuntimeLaunch', () => {
  it('开发布局：仓库 venv 里的 python.exe + `-m personal_agent`', () => {
    const launch = resolveRuntimeLaunch({
      isPackaged: false,
      appPath: APP_PATH,
      resourcesPath: RESOURCES
    })

    const cwd = join('C:', 'repo', 'services', 'agent-runtime')
    expect(launch.command).toBe(join(cwd, '.venv', 'Scripts', 'python.exe'))
    expect(launch.args).toEqual(['-m', 'personal_agent'])
    expect(launch.cwd).toBe(cwd)
  })

  it('打包布局：随包分发的冻结产物，args 为空、不进 venv', () => {
    const launch = resolveRuntimeLaunch({
      isPackaged: true,
      appPath: APP_PATH,
      resourcesPath: RESOURCES
    })

    expect(launch.command).toBe(join(RESOURCES, 'agent-runtime', 'personal_agent.exe'))
    expect(launch.args).toEqual([])
    expect(launch.cwd).toBe(join(RESOURCES, 'agent-runtime'))
  })

  it(`${RUNTIME_ENV} 覆盖优先于打包与开发两种布局`, () => {
    const override = join('D:', 'elsewhere', 'personal_agent.exe')
    const launch = resolveRuntimeLaunch({
      isPackaged: true,
      appPath: APP_PATH,
      resourcesPath: RESOURCES,
      override
    })

    expect(launch.command).toBe(override)
    expect(launch.args).toEqual([])
    expect(launch.cwd).toBe(join('D:', 'elsewhere'))
  })

  it('空字符串的覆盖不算覆盖（等价于没设）', () => {
    const launch = resolveRuntimeLaunch({
      isPackaged: false,
      appPath: APP_PATH,
      resourcesPath: RESOURCES,
      override: ''
    })

    expect(launch.command).toBe(
      join('C:', 'repo', 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
    )
  })
})
