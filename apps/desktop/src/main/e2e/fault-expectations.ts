/**
 * 失败回归集的期望表（TASK-028）。
 *
 * 每个故障场景都要回答同一组问题：任务最后落到哪个终态、**不许**留下什么副作用、
 * 必须留下哪条证据（错误码 / 事件）。把这组判断从用例里抽出来，是因为「什么算收场
 * 正确」是这套回归集的核心，而它不该散在六个 test 的断言里。
 *
 * 与 judgeCase（TASK-027 的单条 eval case 判定）的分工：那边判模型答得好不好，
 * 这边判系统坏得对不对——故障发生时是 fail-closed（没有副作用、留下可查的码），
 * 还是敞开了门。
 */

/** 故障场景。新增一个就同时补一条期望（见 EXPECTATIONS）。 */
export type FaultScenario =
  /** 目录里的 PDF 读不出来（损坏），模型没拿到任何页面 */
  | 'pdf-unreadable'
  /** 用户拒绝了第一条 WRITE 的批准 */
  | 'permission-denied'
  /** Python 在 WRITE 挂起时被杀（真崩溃） */
  | 'python-crashed'
  /** 模型第一步就想调用后面的能力（计划外调用） */
  | 'out-of-plan-call'
  /** 模型一直犯错，直到预算耗尽 */
  | 'budget-exhausted'
  /** 通知发送失败（副作用失败，任务本身已完成） */
  | 'notification-failed'

/** 授权根跑完之后的形态。判定「有没有副作用」看它，不看工具回包。 */
export type RootState =
  /** 一个字节没动：源 PDF 还在原位，没有 Reading */
  | 'untouched'
  /** 建了 Reading 但文件还在原处 */
  | 'reading_only'
  /** 文件进了 Reading（源目录里没有它了） */
  | 'moved'

export interface FaultPermission {
  capability: string
  status: 'pending' | 'approved' | 'denied'
}

/** 一次故障跑完之后，从库里、文件系统与事件流里取到的事实。判定只读这里 */
export interface FaultOutcome {
  scenario: FaultScenario
  /** 任务终态（tasks.status）；没落库就是 unknown */
  taskStatus: 'completed' | 'failed' | 'unknown'
  /** task_failed 事件 payload 里的结构化码（TS 侧失败有：RUNTIME_CRASHED 等）；
   *  Python 自己收场的失败只有人话的 reason，取不到码就是 null */
  failureCode: string | null
  /** task_failed 事件的 payload.code ?? message ?? reason；没有任何失败事件就是 null */
  failureReason: string | null
  /** 授权根的真实形态 */
  rootState: RootState
  /** 这个任务的全部权限记录（按请求顺序） */
  permissions: FaultPermission[]
  /** tool_result 里出现过 ok=false 的能力名 */
  failedToolCalls: string[]
  /** 事件类型清单（按 seq 升序） */
  eventTypes: string[]
  /** Reminder 的终态；这个任务没建 Reminder 就是 null */
  reminderStatus: 'scheduled' | 'firing' | 'fired' | 'failed' | null
}

export interface FaultVerdict {
  ok: boolean
  /** 不符合期望的地方，逐条人话；通过时是空数组 */
  violations: string[]
}

/**
 * 判定口径 —— 逐场景的期望：
 *
 * | 场景 | 终态 | 授权根 | 必须留下的证据 |
 * |------|------|--------|----------------|
 * | pdf-unreadable | failed | untouched | failedToolCalls 含 document.extract_pdf；没有任何权限记录（没走到 WRITE）；failureReason 非空 |
 * | permission-denied | failed | untouched | permissions 里至少一条 denied；没有 approved 的 WRITE |
 * | python-crashed | failed | untouched | failureCode 是 RUNTIME_CRASHED；权限停在 pending（批准窗口没关，重启后由过期投影收） |
 * | out-of-plan-call | completed | moved | failedToolCalls 含那条计划外调用（filesystem.move）；三条 WRITE 都有 approved |
 * | budget-exhausted | failed | untouched | eventTypes 含 budget_exhausted；failureReason 提到预算 |
 * | notification-failed | completed | moved | reminderStatus 为 failed；eventTypes 含 notification_failed |
 *
 * 共用底线（每个场景都查）：
 * 1. 「不许动」的场景里 rootState 必须是 untouched —— 副作用只看文件系统，不看回包；
 * 2. 终态为 failed 时必须有 failureCode（失败要留得下可查的码，不能只有自由文本）；
 * 3. 终态为 completed 时不许出现 budget_exhausted 事件（预算耗尽的完成是巧合，不是通过）。
 *
 * 边界：纯判定，不读库、不读盘、不抛异常。缺东西（状态 unknown、事件为空）一律算
 * 不符合期望 —— 判不出来的时候按失败算。
 *
 * 对应验收测试：apps/desktop/src/main/e2e/failure-regression.test.ts
 */
export function judgeFault(scenario: FaultScenario, outcome: FaultOutcome): FaultVerdict {
  // 占位实现：参数先显式引用一下，免得 lint 报未使用（填实现时删掉这行）。
  void outcome
  // TODO(你填)[思维与算法]: 按上面这张表实现本函数，删掉这段占位。
  //   占位是 fail-closed 的：任何场景都判不符合期望，红点数量就是进度。
  //   自检入口：pnpm --dir apps/desktop exec vitest run src/main/e2e/failure-regression.test.ts
  return {
    ok: false,
    violations: [`judgeFault 尚未实现（TODO(你填)）：期望表见函数上方注释（场景 ${scenario}）`]
  }
}
