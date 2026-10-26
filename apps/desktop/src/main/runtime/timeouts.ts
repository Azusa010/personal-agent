import { PERMISSION_TTL_MS } from '../permission/expiry'

/** 批准窗口的余量 */
const PERMISSION_SLACK_MS = 5_000

/** 批准窗口是有限值时，host 单次调用必须比它更晚超时，否则用户还没点就先回了 HOST_TIMEOUT。 */
export function hostToolTimeoutFor(permissionTtlMs: number | null): number | null {
  return permissionTtlMs === null ? null : permissionTtlMs + PERMISSION_SLACK_MS
}

/** 整任务上限 = 最坏工具调用总和 + 模型思考余量。任一环节不限期，整任务也不限期。 */
export function runTaskTimeoutFor(
  hostToolTimeoutMs: number | null,
  maxToolCalls: number = 40,
  modelSlackMs: number = 500_000
): number | null {
  return hostToolTimeoutMs === null ? null : maxToolCalls * hostToolTimeoutMs + modelSlackMs
}

// null = 不限期：批准卡没人点就一直等，host 调用与整任务都不设超时。
export const HOST_TOOL_TIMEOUT_MS = hostToolTimeoutFor(PERMISSION_TTL_MS)

// 与 Python shared/budget.py 的 DEFAULT_MAX_TOOL_CALLS 必须相等（timeouts.test.ts 直接读源码比对）。
// 预算定位是安全阀：默认 40 对齐 SOTA harness 量级（Manus 披露平均约 50 次调用）。
export const PYTHON_MAX_TOOL_CALLS = 40

// 真实模型每步 2-10 秒 × 最多 50 步（DEFAULT_MAX_STEPS），10s/步顶格算。
export const MODEL_SLACK_MS = 500_000

export const RUN_TASK_TIMEOUT_MS = runTaskTimeoutFor(
  HOST_TOOL_TIMEOUT_MS,
  PYTHON_MAX_TOOL_CALLS,
  MODEL_SLACK_MS
)
