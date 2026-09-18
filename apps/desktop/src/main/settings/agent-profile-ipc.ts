import { z } from 'zod'

import {
  AgentProfile,
  AgentProfileSaveError,
  AgentProfileStore,
  DEFAULT_AGENT_PROFILE
} from './agent-profile'
import { ERROR_CODE } from '@personal-agent/protocol'
import {
  GetAgentProfileResult,
  IpcErrorCode,
  SetAgentProfileInput,
  SetAgentProfileResult
} from 'src/shared/ipc-contract'
import { SETTINGS_ERROR_CODE } from './error-code'

export interface AgentProfileIpcDeps {
  store: AgentProfileStore
}

const SetAgentProfileSchema = z.object({
  name: z.string().optional(),
  persona: z.string().optional(),
  reasoningSummary: z.boolean().optional()
})

function invalid(message: string): { ok: false; code: IpcErrorCode; message: string } {
  return { ok: false, code: ERROR_CODE.PROTOCOL_INVALID_REQUEST, message }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function getAgentProfileView(deps: AgentProfileIpcDeps): GetAgentProfileResult {
  try {
    const profile = deps.store.load() ?? { ...DEFAULT_AGENT_PROFILE }
    return { ok: true, profile }
  } catch (error) {
    return { ok: false, code: SETTINGS_ERROR_CODE.READ_FAILED, message: describe(error) }
  }
}

export async function setAgentProfile(
  input: unknown,
  deps: AgentProfileIpcDeps
): Promise<SetAgentProfileResult> {
  const parsed = SetAgentProfileSchema.safeParse(input)
  if (!parsed.success) {
    return invalid(`人设参数不符合契约: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }
  const patch: SetAgentProfileInput = parsed.data
  let cuurent: AgentProfile
  try {
    cuurent = deps.store.load() ?? { ...DEFAULT_AGENT_PROFILE }
  } catch (error) {
    return { ok: false, code: SETTINGS_ERROR_CODE.READ_FAILED, message: describe(error) }
  }

  const next: AgentProfile = {
    name: patch.name !== undefined ? patch.name : cuurent.name,
    persona: patch.persona !== undefined ? patch.persona : cuurent.persona,
    reasoningSummary:
      patch.reasoningSummary !== undefined ? patch.reasoningSummary : cuurent.reasoningSummary
  }

  try {
    deps.store.save(next)
  } catch (e) {
    if (e instanceof AgentProfileSaveError) {
      return { ok: false, code: e.code, message: e.message }
    }
    return { ok: false, code: SETTINGS_ERROR_CODE.WRITE_FAILED, message: describe(e) }
  }
  return { ok: true, profile: next }
}
