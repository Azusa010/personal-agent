export const RUNTIME_ERROR_CODE = {
  NOT_STARTED: 'RUNTIME_NOT_STARTED',
  TIMEOUT: 'RUNTIME_TIMEOUT',
  CANCELLED: 'RUNTIME_CANCELLED',
  STOPPED: 'RUNTIME_STOPPED',
  CRASHED: 'RUNTIME_CRASHED',
  HANDSHAKE_FAILED: 'RUNTIME_HANDSHAKE_FAILED',
  RESPONSE_INVALID: 'RUNTIME_RESPONSE_INVALID',
  PLAN_INVALID: 'RUNTIME_PLAN_INVALID',
  PLAN_NOT_BUILDABLE: 'PLAN_NOT_BUILDABLE',
  DB_FAILED: 'RUNTIME_DB_FAILED',
  // 单槽设计：ActionAlignment 的比对基准是「当前任务的计划」，两个任务并发时
  // 第二个会拿第一个的计划对齐，判定结果看起来合法却毫无意义。所以这不是业务
  // 失败而是编程错误，直接拒，不排队。
  TASK_BUSY: 'RUNTIME_TASK_BUSY',
  ORPHANED: 'RUNTIME_ORPHANED',
  // 交付物校验未通过（TASK-026）：Python 说完成了，但可信侧的证据不支持。
  // 唯一闸口在 verification/verify-deliverables.ts，任务落 failed 时带这个码。
  VERIFICATION_FAILED: 'RUNTIME_VERIFICATION_FAILED',
  // 计划这一侧没拿到可用计划（TASK-031）：模型规划失败、输出不合契约，或计划用了
  // 不可见的能力。字面值同样由 Python 侧 runtime.py 定，两边必须逐字一致。
  PLAN_MODEL_FAILED: 'PLAN_MODEL_FAILED',
} as const
