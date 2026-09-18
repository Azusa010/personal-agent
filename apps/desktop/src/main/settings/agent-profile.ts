import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SETTINGS_ERROR_CODE } from './error-code'

export interface AgentProfile {
  name: string
  persona: string
  reasoningSummary: boolean
}

export const AGENT_PROFILE_FILE_NAME = 'agent-profile.json'
export const AGENT_PROFILE_VERSION = 1
export const NAME_MAX_LENGTH = 40
export const PERSONA_MAX_LENGTH = 2000

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  name: 'PersonalAgent',
  persona: '',
  reasoningSummary: false
}

interface StoredProfile {
  version: number
  name: string
  persona: string
  reasoningSummary: boolean
}

export interface AgentProfileStoreDeps {
  filePath: string
}

export interface AgentProfileStore {
  load(): AgentProfile | null
  save(profile: AgentProfile): void
}

export class AgentProfileSaveError extends Error {
  constructor(
    readonly code: (typeof SETTINGS_ERROR_CODE)[keyof typeof SETTINGS_ERROR_CODE],
    message: string
  ) {
    super(message)
    this.name = 'AgentProfileSaveError'
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function loadAgentProfile(deps: AgentProfileStoreDeps): AgentProfile | null {
  let raw: string
  try {
    raw = readFileSync(deps.filePath, 'utf8')
  } catch {
    return null
  }

  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }

  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null

  const record = stored as Record<string, unknown>
  if (record.version !== AGENT_PROFILE_VERSION) return null
  if (typeof record.name !== 'string' || record.name.trim() === '') return null

  const name = record.name.trim()
  const persona = typeof record.persona === 'string' ? record.persona.trim() : ''
  const reasoningSummary = Boolean(record.reasoningSummary)

  return { name, persona, reasoningSummary }
}

export function saveAgentProfile(profile: AgentProfile, deps: AgentProfileStoreDeps): void {
  const name = typeof profile.name === 'string' ? profile.name.trim() : ''
  if (!name) {
    throw new AgentProfileSaveError(SETTINGS_ERROR_CODE.PROFILE_INVALID, '助手名称不能为空')
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new AgentProfileSaveError(
      SETTINGS_ERROR_CODE.PROFILE_INVALID,
      `助手名称长度不能超过 ${NAME_MAX_LENGTH} 个字符`
    )
  }

  const persona = typeof profile.persona === 'string' ? profile.persona.trim() : ''
  if (persona.length > PERSONA_MAX_LENGTH) {
    throw new AgentProfileSaveError(
      SETTINGS_ERROR_CODE.PROFILE_INVALID,
      `人设描述长度不能超过 ${PERSONA_MAX_LENGTH} 个字符`
    )
  }

  const reasoningSummary = Boolean(profile.reasoningSummary)

  const stored: StoredProfile = {
    version: AGENT_PROFILE_VERSION,
    name,
    persona,
    reasoningSummary
  }

  try {
    mkdirSync(dirname(deps.filePath), { recursive: true })
    writeFileSync(deps.filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  } catch (e) {
    throw new AgentProfileSaveError(SETTINGS_ERROR_CODE.WRITE_FAILED, describe(e))
  }
}

export function createAgentProfileStore(deps: AgentProfileStoreDeps): AgentProfileStore {
  return {
    load: () => loadAgentProfile(deps),
    save: (profile: AgentProfile) => saveAgentProfile(profile, deps)
  }
}
