import { PERMISSION_TTL_MS } from '../permission/expiry'

/** 批准窗口的余量 */
const PERMISSION_SLACK_MS = 5_000

export const HOST_TOOL_TIMEOUT_MS = PERMISSION_TTL_MS + PERMISSION_SLACK_MS

// 与 Python shared/budget.py 的 DEFAULT_MAX_TOOL_CALLS 必须相等（timeouts.test.ts 直接读源码比对）。
// 预算定位是安全阀：默认 40 对齐 SOTA harness 量级（Manus 披露平均约 50 次调用）。
export const PYTHON_MAX_TOOL_CALLS = 40

// 真实模型每步 2-10 秒 × 最多 50 步（DEFAULT_MAX_STEPS），10s/步顶格算。
export const MODEL_SLACK_MS = 500_000

export const RUN_TASK_TIMEOUT_MS = PYTHON_MAX_TOOL_CALLS * HOST_TOOL_TIMEOUT_MS + MODEL_SLACK_MS
