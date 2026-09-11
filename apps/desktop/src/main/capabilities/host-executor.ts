import {
  ERROR_CODE,
  HostExecuteToolParams,
  type CapabilityDescriptor
} from '@personal-agent/protocol'

import { createExecutor, type CapabilityOutcome } from './executor'
import { RuleBasedToolRetriever } from './retriever'
import { readOnlyScope } from './scope'

const BOOTSTRAP_TASK_ID = 'bootstrap'
const BOOTSTRAP_SCOPE = readOnlyScope(BOOTSTRAP_TASK_ID)

const retriever = new RuleBasedToolRetriever()

const executor = createExecutor(BOOTSTRAP_SCOPE, retriever)

let ipcCounter = 0

// 下发给 Python 的清单必须与 executor 实际放行的是同一个 scope 实例，
// 否则模型看见的能力和它真正能调的能力会分叉。
export function listVisibleCapabilities(): readonly CapabilityDescriptor[] {
  return retriever.listVisible(BOOTSTRAP_SCOPE)
}

// 给PythonSupervisor的hosthandler
export async function executeHostTool(params: HostExecuteToolParams): Promise<CapabilityOutcome> {
  return executor(params)
}

// 给IPC的网关
// Renderer 与 Agent 两条路径在这里汇合：同一套契约校验、同一个 scope、
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
  return executor(parsed.data)
}
