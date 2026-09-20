import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { PERMISSION_TTL_MS } from '../permission/expiry'
import {
  HOST_TOOL_TIMEOUT_MS,
  MODEL_SLACK_MS,
  PYTHON_MAX_TOOL_CALLS,
  RUN_TASK_TIMEOUT_MS
} from './timeouts'

/** supervisor 的 defaultTimeoutMs 默认值。它不参与推导，只作为下界被比。 */
const SUPERVISOR_DEFAULT_TIMEOUT_MS = 30_000

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..', '..')
const enginePy = join(repoRoot, 'services', 'agent-runtime', 'src', 'personal_agent', 'engine.py')
const budgetPy = join(
  repoRoot,
  'services',
  'agent-runtime',
  'src',
  'personal_agent',
  'shared',
  'budget.py'
)

describe('三层超时链', () => {
  it('批准窗口先于传输层超时结束：HOST_TOOL_TIMEOUT_MS > PERMISSION_TTL_MS', () => {
    // 反过来的话 handler 先超时，supervisor 写一条 HOST_TIMEOUT 的 error envelope，
    // Python 侧 call_host 抛 HostRequestFailed，engine 直接 _fail —— 用户根本来不及点批准。
    // 而且超时之后 handler 的返回值会被丢弃，批准了也传不回去。
    expect(HOST_TOOL_TIMEOUT_MS).toBeGreaterThan(PERMISSION_TTL_MS)
  })

  it('字面值钉住：改动必须是有意的', () => {
    expect(PERMISSION_TTL_MS).toBe(300_000)
    expect(HOST_TOOL_TIMEOUT_MS).toBe(305_000)
    expect(PYTHON_MAX_TOOL_CALLS).toBe(8)
    expect(MODEL_SLACK_MS).toBe(120_000)
    // 8 * 305_000 + 120_000
    expect(RUN_TASK_TIMEOUT_MS).toBe(2_560_000)
  })

  it('RUN_TASK_TIMEOUT_MS 是推导出来的，不是各自硬编码', () => {
    expect(RUN_TASK_TIMEOUT_MS).toBe(PYTHON_MAX_TOOL_CALLS * HOST_TOOL_TIMEOUT_MS + MODEL_SLACK_MS)
  })

  it('必须大于 Python 侧最坏执行时间，否则 TS 先超时而 Python 还在跑', () => {
    // 8 次工具调满（全要用户批准 + 走到 300s 截止前一秒）+ 每步等模型 10 秒
    const worstCaseExecutionMs = 8 * 300_000 + 8 * 10_000
    expect(RUN_TASK_TIMEOUT_MS).toBeGreaterThan(worstCaseExecutionMs)
    // 接进来之后每步 2-10 秒 × maxSteps。
    expect(MODEL_SLACK_MS).toBeGreaterThanOrEqual(120_000)
  })

  it('必须大于 supervisor 的 defaultTimeoutMs，否则透传没有意义', () => {
    expect(RUN_TASK_TIMEOUT_MS).toBeGreaterThan(SUPERVISOR_DEFAULT_TIMEOUT_MS)
  })
})

describe('与 Python 侧 Budget 的一致性', () => {
  function readDefault(name: string): number {
    const targetFile = existsSync(budgetPy) ? budgetPy : enginePy
    const source = readFileSync(targetFile, 'utf8')
    const matched = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(source)
    expect(matched, `Python 侧找不到 ${name}`).not.toBeNull()
    return Number(matched?.[1])
  }

  it('PYTHON_MAX_TOOL_CALLS 等于 DEFAULT_MAX_TOOL_CALLS', () => {
    expect(PYTHON_MAX_TOOL_CALLS).toBe(readDefault('DEFAULT_MAX_TOOL_CALLS'))
  })

  it('DEFAULT_MAX_STEPS 也钉住：MODEL_SLACK_MS 是按它算的', () => {
    // 步数涨了而余量没跟着涨，RUN_TASK_TIMEOUT_MS 就不够真实模型跑完一轮。
    // 这里不钉公式（每步耗时是估值），只钉「改了必须回头看 MODEL_SLACK_MS」。
    expect(readDefault('DEFAULT_MAX_STEPS')).toBe(12)
  })
})
