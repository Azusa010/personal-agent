import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { PERMISSION_TTL_MS } from '../../../src/main/permission/expiry'
import {
  HOST_TOOL_TIMEOUT_MS,
  MODEL_SLACK_MS,
  PYTHON_MAX_TOOL_CALLS,
  RUN_TASK_TIMEOUT_MS,
  hostToolTimeoutFor,
  runTaskTimeoutFor
} from '../../../src/main/runtime/timeouts'

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
  it('当前配置不限期：批准窗口、host 调用与整任务都不设超时', () => {
    // 批准卡没人点就一直等，所以整条链路都不能有定时器把它先掐掉：
    // handler 先超时的话，用户之后的批准传不回 Python，等于白点。
    expect(PERMISSION_TTL_MS).toBeNull()
    expect(HOST_TOOL_TIMEOUT_MS).toBeNull()
    expect(RUN_TASK_TIMEOUT_MS).toBeNull()
  })

  it('有限 TTL 的推导：host 超时 = TTL + 余量，null 一路传染', () => {
    // 反过来的话 handler 先超时，supervisor 写 HOST_TIMEOUT，用户根本来不及点批准。
    expect(hostToolTimeoutFor(300_000)).toBe(305_000)
    expect(hostToolTimeoutFor(300_000)).toBeGreaterThan(300_000)
    expect(hostToolTimeoutFor(null)).toBeNull()
  })

  it('整任务上限是推导出来的：40 次满额 + 模型余量', () => {
    expect(runTaskTimeoutFor(305_000, 40, 500_000)).toBe(12_700_000)
    expect(runTaskTimeoutFor(null)).toBeNull()
  })

  it('字面值钉住：改动必须是有意的', () => {
    expect(PYTHON_MAX_TOOL_CALLS).toBe(40)
    expect(MODEL_SLACK_MS).toBe(500_000)
  })

  it('RUN_TASK_TIMEOUT_MS 跟随 HOST_TOOL_TIMEOUT_MS，不是各自硬编码', () => {
    expect(RUN_TASK_TIMEOUT_MS).toBe(
      runTaskTimeoutFor(HOST_TOOL_TIMEOUT_MS, PYTHON_MAX_TOOL_CALLS, MODEL_SLACK_MS)
    )
  })

  it('有限配置下整任务上限必须大于 Python 侧最坏执行时间', () => {
    // 40 次工具调满（全要用户批准 + 走到 300s 截止前一秒）+ 50 步每步等模型 10 秒
    const worstCaseExecutionMs = 40 * 300_000 + 50 * 10_000
    expect(runTaskTimeoutFor(hostToolTimeoutFor(300_000))).toBeGreaterThan(worstCaseExecutionMs)
    // 每步 2-10 秒 × maxSteps（50 步 × 10s 顶格 = 500s）。
    expect(MODEL_SLACK_MS).toBeGreaterThanOrEqual(500_000)
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
    expect(readDefault('DEFAULT_MAX_STEPS')).toBe(50)
  })
})
