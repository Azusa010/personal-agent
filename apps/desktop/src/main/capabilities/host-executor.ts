import { ERROR_CODE, HostExecuteToolParams } from '@personal-agent/protocol'
import { CapabilityOutcome, createExecutor } from './executor'
import { readOnlyScope } from './scope'

const BOOTSTRAP_TASK_ID = 'bootstrap'

const executor = createExecutor(readOnlyScope(BOOTSTRAP_TASK_ID))

// 给PythonSupervisor的hosthandler
export async function executeHostTool(params): Promise<CapabilityOutcome> {
  return executor(params)
}

// 给IPC的网关
// Renderer 与 Agent 两条路径在这里汇合：同一套契约校验、同一个 scope、
export async function executeCapability(
  capability: string,
  args: Record<string, unknown>
): Promise<CapabilityOutcome> {
  const ipcCounter = 1
  const parsed = HostExecuteToolParams.safeParse({
    callId: `ipc-${ipcCounter}`,
    capability,
    args
  })
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      code: ERROR_CODE.INVALID_ARGUMENT,
      reason: `capability 或 arguments 不符合契约: ${parsed.error.message}`
    })
  }
  return executor(parsed.data)
}
