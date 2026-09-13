import {
  ERROR_CODE,
  HostExecuteToolParams,
  type CapabilityDescriptor
} from '@personal-agent/protocol'

import { AGENT_ORIGIN, UI_ORIGIN } from '../policy/execution-policy'
import { createExecutor, type CapabilityOutcome } from './executor'
import { RuleBasedToolRetriever } from './retriever'
import { readOnlyScope } from './scope'

const BOOTSTRAP_TASK_ID = 'bootstrap'
const BOOTSTRAP_SCOPE = readOnlyScope(BOOTSTRAP_TASK_ID)

const retriever = new RuleBasedToolRetriever()

// 同一个 scope、同一个 retriever 实例，两套 origin：
// agent 那条多两关（必须有当前任务、必须对齐计划），ui 那条没有。
const agentExecutor = createExecutor(BOOTSTRAP_SCOPE, AGENT_ORIGIN, retriever)
const uiExecutor = createExecutor(BOOTSTRAP_SCOPE, UI_ORIGIN, retriever)

let ipcCounter = 0

// 下发给 Python 的清单必须与 executor 实际放行的是同一个 scope 实例，
// 否则模型看见的能力和它真正能调的能力会分叉。
export function listVisibleCapabilities(): readonly CapabilityDescriptor[] {
  return retriever.listVisible(BOOTSTRAP_SCOPE)
}

// 给PythonSupervisor的hosthandler。只有 run-task.ts beginTask 之后才放行。
export async function executeHostTool(params: HostExecuteToolParams): Promise<CapabilityOutcome> {
  return agentExecutor(params)
}

// 给IPC的网关。renderer 没有任务上下文，所以走 ui origin：
// 注册、Scope、风险、契约、路径五关照过，只是不拿计划对齐。
export async function executeCapability(
  capability: string,
  args: Record<string, unknown>
): Promise<CapabilityOutcome> {
  ipcCounter += 1
  const parsed = HostExecuteToolParams.safeParse({
    callId: `ipc-${ipcCounter}`,
    capability,
    arguments: args
  })
  if (!parsed.success) {
    return {
      ok: false,
      code: ERROR_CODE.INVALID_ARGUMENT,
      reason: `capability 或 arguments 不符合契约: ${parsed.error.message}`
    }
  }
  return uiExecutor(parsed.data)
}
