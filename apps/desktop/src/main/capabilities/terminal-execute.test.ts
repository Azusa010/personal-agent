import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ERROR_CODE,
  TerminalExecuteResult,
  type HostExecuteToolParams
} from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createExecutor } from './executor'
import { UI_ORIGIN, type PermissionGate } from '../policy/execution-policy'
import { RuleBasedToolRetriever } from './retriever'
import type { TaskScope } from './scope'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

let dir: string
const scope: TaskScope = {
  taskId: 't-terminal',
  capabilities: ['terminal_execute']
}

function allowAllGate(): PermissionGate {
  return {
    request: async () => ({ approved: true }),
    verify: async () => ({ ok: true })
  }
}

function denyGate(reason = '用户拒绝了执行'): PermissionGate {
  return {
    request: async () => ({ approved: false, code: ERROR_CODE.PERMISSION_DENIED, reason }),
    verify: async () => ({ ok: false, code: ERROR_CODE.PERMISSION_DENIED, reason })
  }
}

function terminalParams(args: Record<string, unknown>): HostExecuteToolParams {
  return {
    callId: 'call-1',
    capability: 'terminal_execute',
    arguments: args
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-term-'))
  vi.stubEnv(ENV_NAME, dir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // Windows file locking in temp dir
  }
})

describe('terminal_execute 执行体', () => {
  it('执行简单命令成功：返回 ok: true, exitCode: 0 并捕获 stdout', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    // 在 Windows 环境下使用 cmd.exe 内置命令 echo
    const res = await executor(terminalParams({ command: 'echo hello_personal_agent' }))
    const parsed = TerminalExecuteResult.safeParse(res)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.ok).toBe(true)
      expect(parsed.data.exitCode).toBe(0)
      expect(parsed.data.stdout).toContain('hello_personal_agent')
    }
  })

  it('命令退出码非 0：返回 ok: true，包含 exitCode 和 stderr', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    // exit 1 会让进程退出码为 1
    const res = await executor(terminalParams({ command: 'exit 1' }))
    const parsed = TerminalExecuteResult.safeParse(res)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.ok).toBe(true)
      expect(parsed.data.exitCode).toBe(1)
    }
  })

  it('指定 cwd：命令在指定工作目录运行', async () => {
    const sub = join(dir, 'mysubdir')
    await mkdir(sub, { recursive: true })

    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    // Windows cd 命令打印当前工作目录
    const res = await executor(terminalParams({ command: 'cd', cwd: 'mysubdir' }))
    expect(res['ok']).toBe(true)
    expect(String(res['stdout'])).toContain('mysubdir')
  })

  it('超时处理：超时触发 TERMINAL_TIMEOUT', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    // 使用 node 挂起命令，设置极短超时 100ms
    const res = await executor(
      terminalParams({
        command: 'node -e "setTimeout(() => {}, 2000)"',
        timeoutMs: 100
      })
    )

    expect(res['ok']).toBe(false)
    expect(res['code']).toBe(ERROR_CODE.TERMINAL_TIMEOUT)
    expect(String(res['reason'])).toContain('超时')
  })

  it('权限拒绝时安全阻断：未执行即返回 PERMISSION_DENIED', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: denyGate('测试拒绝理由')
    })

    const res = await executor(terminalParams({ command: 'echo dangerous' }))
    expect(res['ok']).toBe(false)
    expect(res['code']).toBe(ERROR_CODE.PERMISSION_DENIED)
    expect(String(res['reason'])).toContain('测试拒绝理由')
  })
})
