import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AGENT_PROFILE_FILE_NAME,
  AGENT_PROFILE_VERSION,
  AgentProfileSaveError,
  createAgentProfileStore,
  DEFAULT_AGENT_PROFILE,
  loadAgentProfile,
  saveAgentProfile,
  type AgentProfile
} from './agent-profile'
import { SETTINGS_ERROR_CODE } from './error-code'

const TEST_DIR = join(__dirname, '../../../../tmp/test-agent-profile-' + process.pid)
const TEST_FILE = join(TEST_DIR, AGENT_PROFILE_FILE_NAME)

describe('agent-profile 存储与校验（TASK-034 R1）', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('DEFAULT_AGENT_PROFILE 常量', () => {
    it('默认人设名称为 PersonalAgent，人设为空，思维摘要默认关闭', () => {
      expect(DEFAULT_AGENT_PROFILE).toEqual({
        name: 'PersonalAgent',
        persona: '',
        reasoningSummary: false
      })
    })
  })

  describe('loadAgentProfile', () => {
    it('文件不存在时返回 null（未自定义配置）', () => {
      const loaded = loadAgentProfile({ filePath: join(TEST_DIR, 'non-existent.json') })
      expect(loaded).toBeNull()
    })

    it('文件内容不是合法 JSON 时返回 null', () => {
      writeFileSync(TEST_FILE, 'not a valid json', 'utf8')
      expect(loadAgentProfile({ filePath: TEST_FILE })).toBeNull()
    })

    it('JSON 顶层不是对象时返回 null', () => {
      writeFileSync(TEST_FILE, JSON.stringify(['array']), 'utf8')
      expect(loadAgentProfile({ filePath: TEST_FILE })).toBeNull()
    })

    it('版本号不匹配时返回 null', () => {
      writeFileSync(
        TEST_FILE,
        JSON.stringify({
          version: AGENT_PROFILE_VERSION + 1,
          name: '小助手',
          persona: '测试',
          reasoningSummary: false
        }),
        'utf8'
      )
      expect(loadAgentProfile({ filePath: TEST_FILE })).toBeNull()
    })

    it('name 缺失或不是非空字符串时返回 null', () => {
      writeFileSync(
        TEST_FILE,
        JSON.stringify({
          version: AGENT_PROFILE_VERSION,
          name: '',
          persona: '测试',
          reasoningSummary: false
        }),
        'utf8'
      )
      expect(loadAgentProfile({ filePath: TEST_FILE })).toBeNull()

      writeFileSync(
        TEST_FILE,
        JSON.stringify({
          version: AGENT_PROFILE_VERSION,
          persona: '测试',
          reasoningSummary: false
        }),
        'utf8'
      )
      expect(loadAgentProfile({ filePath: TEST_FILE })).toBeNull()
    })

    it('合法文件成功解析并返回 AgentProfile', () => {
      const stored = {
        version: AGENT_PROFILE_VERSION,
        name: '研究助手',
        persona: '擅长文献阅读与总结',
        reasoningSummary: true
      }
      writeFileSync(TEST_FILE, JSON.stringify(stored), 'utf8')
      const profile = loadAgentProfile({ filePath: TEST_FILE })
      expect(profile).toEqual({
        name: '研究助手',
        persona: '擅长文献阅读与总结',
        reasoningSummary: true
      })
    })

    it('persona 缺省或非字符串时安全回退为空串，reasoningSummary 安全转为布尔', () => {
      const stored = {
        version: AGENT_PROFILE_VERSION,
        name: '极简助手'
      }
      writeFileSync(TEST_FILE, JSON.stringify(stored), 'utf8')
      const profile = loadAgentProfile({ filePath: TEST_FILE })
      expect(profile).toEqual({
        name: '极简助手',
        persona: '',
        reasoningSummary: false
      })
    })
  })

  describe('saveAgentProfile', () => {
    it('正常保存：去除首尾空白并以 JSON 格式写入文件', () => {
      const profile: AgentProfile = {
        name: '  整理助手  ',
        persona: '  专注整理归档  ',
        reasoningSummary: true
      }
      saveAgentProfile(profile, { filePath: TEST_FILE })

      const raw = readFileSync(TEST_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed).toEqual({
        version: AGENT_PROFILE_VERSION,
        name: '整理助手',
        persona: '专注整理归档',
        reasoningSummary: true
      })
    })

    it('name 为空或纯空白时抛 PROFILE_INVALID 异常', () => {
      expect(() => {
        saveAgentProfile(
          { name: '   ', persona: '测试', reasoningSummary: false },
          { filePath: TEST_FILE }
        )
      }).toThrowError(AgentProfileSaveError)

      try {
        saveAgentProfile(
          { name: '', persona: '测试', reasoningSummary: false },
          { filePath: TEST_FILE }
        )
      } catch (e) {
        expect(e).toBeInstanceOf(AgentProfileSaveError)
        expect((e as AgentProfileSaveError).code).toBe(SETTINGS_ERROR_CODE.PROFILE_INVALID)
        expect((e as AgentProfileSaveError).message).toContain('助手名称不能为空')
      }
    })

    it('name 超过 40 字符时抛 PROFILE_INVALID 异常', () => {
      const longName = 'a'.repeat(41)
      try {
        saveAgentProfile(
          { name: longName, persona: '', reasoningSummary: false },
          { filePath: TEST_FILE }
        )
        expect.unreachable('应抛出异常')
      } catch (e) {
        expect(e).toBeInstanceOf(AgentProfileSaveError)
        expect((e as AgentProfileSaveError).code).toBe(SETTINGS_ERROR_CODE.PROFILE_INVALID)
        expect((e as AgentProfileSaveError).message).toContain('40')
      }
    })

    it('persona 超过 2000 字符时抛 PROFILE_INVALID 异常', () => {
      const longPersona = 'p'.repeat(2001)
      try {
        saveAgentProfile(
          { name: '助手', persona: longPersona, reasoningSummary: false },
          { filePath: TEST_FILE }
        )
        expect.unreachable('应抛出异常')
      } catch (e) {
        expect(e).toBeInstanceOf(AgentProfileSaveError)
        expect((e as AgentProfileSaveError).code).toBe(SETTINGS_ERROR_CODE.PROFILE_INVALID)
        expect((e as AgentProfileSaveError).message).toContain('2000')
      }
    })

    it('写入目标目录不存在时自动创建目录', () => {
      const nestedFile = join(TEST_DIR, 'sub', 'nested', AGENT_PROFILE_FILE_NAME)
      saveAgentProfile(
        { name: '助手', persona: '', reasoningSummary: false },
        { filePath: nestedFile }
      )
      expect(loadAgentProfile({ filePath: nestedFile })?.name).toBe('助手')
    })
  })

  describe('createAgentProfileStore', () => {
    it('创建的 store 可以进行 load 和 save 闭环', () => {
      const store = createAgentProfileStore({ filePath: TEST_FILE })
      expect(store.load()).toBeNull()

      store.save({ name: '存储测试', persona: '闭环测试', reasoningSummary: true })
      expect(store.load()).toEqual({
        name: '存储测试',
        persona: '闭环测试',
        reasoningSummary: true
      })
    })
  })
})
