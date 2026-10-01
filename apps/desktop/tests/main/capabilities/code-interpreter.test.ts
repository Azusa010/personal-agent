import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CodeInterpreterResult,
  ERROR_CODE,
  type HostExecuteToolParams
} from '@personal-agent/protocol'
import { createExecutor } from '../../../src/main/capabilities/executor'
import { UI_ORIGIN, type PermissionGate } from '../../../src/main/policy/execution-policy'
import { RuleBasedToolRetriever } from '../../../src/main/capabilities/retriever'
import type { TaskScope } from '../../../src/main/capabilities/scope'
import { codeInterpreterPlugin } from '../../../src/main/capabilities/plugins/code-interpreter'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

let dir: string
const scope: TaskScope = {
  taskId: 't-code',
  capabilities: ['code_interpreter']
}

function allowAllGate(): PermissionGate {
  return {
    request: async () => ({ approved: true }),
    verify: async () => ({ ok: true })
  }
}

function denyGate(reason = '用户拒绝执行'): PermissionGate {
  return {
    request: async () => ({ approved: false, code: ERROR_CODE.PERMISSION_DENIED, reason }),
    verify: async () => ({ ok: false, code: ERROR_CODE.PERMISSION_DENIED, reason })
  }
}

function codeParams(args: Record<string, unknown>): HostExecuteToolParams {
  return {
    callId: 'call-1',
    capability: 'code_interpreter',
    arguments: args
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-code-'))
  vi.stubEnv(ENV_NAME, dir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // Windows file lock
  }
})

describe('code_interpreter 执行体 (沙盒 Python 编排环境)', () => {
  it('执行简单 Python 代码成功并捕获输出', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      codeParams({
        code: 'print("hello_from_sandbox")'
      })
    )

    const parsed = CodeInterpreterResult.safeParse(res)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.ok).toBe(true)
      expect(parsed.data.exitCode).toBe(0)
      expect(parsed.data.stdout).toContain('hello_from_sandbox')
    }
  })

  it('脚本非零退出码正常捕获', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      codeParams({
        code: 'import sys\nprint("error_info", file=sys.stderr)\nsys.exit(42)'
      })
    )

    const parsed = CodeInterpreterResult.safeParse(res)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.ok).toBe(true)
      expect(parsed.data.exitCode).toBe(42)
      expect(parsed.data.stderr).toContain('error_info')
    }
  })

  it('生成文件并返回 artifacts 清单 (saveArtifacts: true)', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      codeParams({
        code: 'with open("result.csv", "w") as f:\n    f.write("a,b,c\\n1,2,3")\nprint("done")',
        saveArtifacts: true
      })
    )

    expect(res['ok']).toBe(true)
    const artifacts = res['artifacts'] as string[]
    expect(artifacts.length).toBeGreaterThanOrEqual(1)
    expect(artifacts.some((a) => a.endsWith('result.csv'))).toBe(true)
  })

  it('执行超时触发 TERMINAL_TIMEOUT', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      codeParams({
        code: 'import time\ntime.sleep(2)',
        timeoutMs: 150
      })
    )

    expect(res['ok']).toBe(false)
    expect(res['code']).toBe(ERROR_CODE.TERMINAL_TIMEOUT)
  })

  it('权限拒绝时阻断执行', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: denyGate('测试代码权限拒绝')
    })

    const res = await executor(
      codeParams({
        code: 'print("should not execute")'
      })
    )

    expect(res['ok']).toBe(false)
    expect(res['code']).toBe(ERROR_CODE.PERMISSION_DENIED)
    expect(String(res['reason'])).toContain('测试代码权限拒绝')
  })
})

describe('code_interpreter 描述符思考引导 (TASK-B1)', () => {
  it('包含符号计算、逻辑推理与统计建模等代码思考引导语', () => {
    const desc = codeInterpreterPlugin.descriptor.description
    expect(desc).toContain('必须优先用代码而非纯文本推理')
    expect(desc).toContain('sympy')
    expect(desc).toContain('python-constraint')
    expect(desc).toContain('numpy/scipy')
    expect(desc).toContain('代码推理比自然语言推理更精确、可验证、可复现')
  })
})
