import { ERROR_CODE, HostExecuteToolParams } from '@personal-agent/protocol'

import { createExecutor, type CapabilityOutcome } from './executor'
import { readOnlyScope } from './scope'

const BOOTSTRAP_TASK_ID = 'bootstrap'

const executor = createExecutor(readOnlyScope(BOOTSTRAP_TASK_ID))

let ipcCounter = 0

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
