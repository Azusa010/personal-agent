import { PERMISSION_TTL_MS } from '../permission/expiry'

/** 批准窗口的余量 */
const PERMISSION_SLACK_MS = 5_000

export const HOST_TOOL_TIMEOUT_MS = PERMISSION_TTL_MS + PERMISSION_SLACK_MS

// 与 Python engine.py 的 DEFAULT_MAX_TOOL_CALLS 必须相等（timeouts.test.ts 直接读源码比对）。
// TASK-028 抬到 8：完整 Golden Path 要 5 次工具调用，而预算在每次决策之前判，
// 5 会让模型做完第五步就再也给不出摘要。
export const PYTHON_MAX_TOOL_CALLS = 8

// 真实模型每步 2-10 秒 × 最多 12 步（DEFAULT_MAX_STEPS）再加网络抖动。
export const MODEL_SLACK_MS = 120_000

export const RUN_TASK_TIMEOUT_MS = PYTHON_MAX_TOOL_CALLS * HOST_TOOL_TIMEOUT_MS + MODEL_SLACK_MS
