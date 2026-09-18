import { describe, expect, it } from 'vitest'

import { ERROR_CODE } from '@personal-agent/protocol'

import {
  AgentProfileSaveError,
  DEFAULT_AGENT_PROFILE,
  type AgentProfile,
  type AgentProfileStore
} from './agent-profile'
import { getAgentProfileView, setAgentProfile } from './agent-profile-ipc'
import { SETTINGS_ERROR_CODE } from './error-code'

class InMemoryProfileStore implements AgentProfileStore {
  constructor(public profile: AgentProfile | null = null) {}

  load(): AgentProfile | null {
    return this.profile
  }

  save(profile: AgentProfile): void {
    const trimmedName = profile.name.trim()
    if (!trimmedName) {
      throw new AgentProfileSaveError(SETTINGS_ERROR_CODE.PROFILE_INVALID, '助手名称不能为空')
    }
    if (trimmedName.length > 40) {
      throw new AgentProfileSaveError(
        SETTINGS_ERROR_CODE.PROFILE_INVALID,
        '助手名称长度不能超过 40 个字符'
      )
    }
    const trimmedPersona = profile.persona.trim()
    if (trimmedPersona.length > 2000) {
      throw new AgentProfileSaveError(
        SETTINGS_ERROR_CODE.PROFILE_INVALID,
        '人设描述长度不能超过 2000 个字符'
      )
    }
    this.profile = {
      name: trimmedName,
      persona: trimmedPersona,
      reasoningSummary: Boolean(profile.reasoningSummary)
    }
  }
}

describe('agent-profile-ipc IPC 处理层（TASK-034 R1）', () => {
  describe('getAgentProfileView', () => {
    it('未曾保存过时返回默认人设', () => {
      const store = new InMemoryProfileStore(null)
      const res = getAgentProfileView({ store })
      expect(res).toEqual({
        ok: true,
        profile: DEFAULT_AGENT_PROFILE
      })
    })

    it('有已保存人设时返回存储的人设', () => {
      const store = new InMemoryProfileStore({
        name: '编程助手',
        persona: '擅长写代码与架构设计',
        reasoningSummary: true
      })
      const res = getAgentProfileView({ store })
      expect(res).toEqual({
        ok: true,
        profile: {
          name: '编程助手',
          persona: '擅长写代码与架构设计',
          reasoningSummary: true
        }
      })
    })

    it('store.load 发生未预期的异常时收敛为 SETTINGS_READ_FAILED', () => {
      const store: AgentProfileStore = {
        load: () => {
          throw new Error('磁盘损坏')
        },
        save: () => {}
      }
      const res = getAgentProfileView({ store })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe(SETTINGS_ERROR_CODE.READ_FAILED)
        expect(res.message).toContain('磁盘损坏')
      }
    })
  })

  describe('setAgentProfile', () => {
    it('参数不合法时返回 PROTOCOL_INVALID_REQUEST', async () => {
      const store = new InMemoryProfileStore()
      const res = await setAgentProfile({ name: 12345 }, { store })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
      }
    })

    it('正常更新并合并现有 profile', async () => {
      const store = new InMemoryProfileStore({
        name: '初始名称',
        persona: '初始设定',
        reasoningSummary: false
      })
      const res = await setAgentProfile({ name: '新名称', reasoningSummary: true }, { store })
      expect(res).toEqual({
        ok: true,
        profile: {
          name: '新名称',
          persona: '初始设定',
          reasoningSummary: true
        }
      })
      expect(store.profile).toEqual({
        name: '新名称',
        persona: '初始设定',
        reasoningSummary: true
      })
    })

    it('首次配置时在默认 profile 基础上应用 patch', async () => {
      const store = new InMemoryProfileStore(null)
      const res = await setAgentProfile({ persona: '你是一位得力助手' }, { store })
      expect(res).toEqual({
        ok: true,
        profile: {
          name: DEFAULT_AGENT_PROFILE.name,
          persona: '你是一位得力助手',
          reasoningSummary: false
        }
      })
    })

    it('存储层校验失败抛出 AgentProfileSaveError 时如实映射 code 与 message', async () => {
      const store = new InMemoryProfileStore()
      const res = await setAgentProfile({ name: '   ' }, { store })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe(SETTINGS_ERROR_CODE.PROFILE_INVALID)
        expect(res.message).toContain('助手名称不能为空')
      }
    })

    it('写入发生底层非预期错误时收敛为 SETTINGS_WRITE_FAILED', async () => {
      const store: AgentProfileStore = {
        load: () => null,
        save: () => {
          throw new Error('只读文件系统')
        }
      }
      const res = await setAgentProfile({ name: '测试' }, { store })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe(SETTINGS_ERROR_CODE.WRITE_FAILED)
        expect(res.message).toContain('只读文件系统')
      }
    })
  })
})
