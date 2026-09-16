/**
 * 设置存储与 env 合成的聚焦测试（TASK-030）。
 *
 * describe('buildRuntimeEnv') 是陪练点：主人填完之前，期望「注入 / 覆盖」的用例是红的，
 * 期望「拷贝语义」的是绿的。其余 describe 不是陪练点，跑起来就该全绿。
 *
 * 不 import electron：路径与密钥库都是注入的——临时目录 + 可逆的假 codec，
 * 所以「加密不可用」「密文解不开」这些分支能被直接构造。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SETTINGS_ERROR_CODE } from './error-code'
import {
  API_KEY_ENV_KEY,
  BASE_URL_ENV_KEY,
  MODEL_ENV_KEY,
  SCRIPT_ENV_KEY,
  SETTINGS_VERSION,
  SettingsSaveError,
  buildRuntimeEnv,
  loadModelSettings,
  saveModelSettings,
  type ModelSettings,
  type SecretCodec
} from './model-settings'

/** 可逆的假密钥库。密文带 `enc:` 前缀，方便断言「文件里没有明文」。 */
function fakeCodec(available = true): SecretCodec {
  return {
    isAvailable: () => available,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (encrypted) => {
      if (!encrypted.startsWith('enc:')) throw new Error('密文格式不对')
      return Buffer.from(encrypted.slice(4), 'base64').toString('utf8')
    }
  }
}

const SECRET = 'sk-secret-key-0123456789'

function catchError(fn: () => void): unknown {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

let dir: string
let filePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-model-settings-'))
  filePath = join(dir, 'model-settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('model-settings: 读写往返', () => {
  it('三个字段存下去、读回来完全一致', () => {
    const settings: ModelSettings = {
      model: 'gpt-4o-mini',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: SECRET
    }

    saveModelSettings(settings, { filePath, codec: fakeCodec() })

    expect(loadModelSettings({ filePath, codec: fakeCodec() })).toEqual(settings)
  })

  it('Key 只以密文落盘：文件里搜不到明文（SEC-008）', () => {
    saveModelSettings(
      { model: null, baseUrl: null, apiKey: SECRET },
      { filePath, codec: fakeCodec() }
    )

    const raw = readFileSync(filePath, 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(JSON.parse(raw)).toMatchObject({
      version: SETTINGS_VERSION,
      apiKeyEncrypted: `enc:${Buffer.from(SECRET, 'utf8').toString('base64')}`
    })
  })

  it('空串与纯空白字段归一化成 null 落盘', () => {
    saveModelSettings({ model: '  ', baseUrl: '', apiKey: '   ' }, { filePath, codec: fakeCodec() })

    expect(loadModelSettings({ filePath, codec: fakeCodec() })).toEqual({
      model: null,
      baseUrl: null,
      apiKey: null
    })
  })

  it('文件不存在 → null（从没配过，不是失败）', () => {
    expect(loadModelSettings({ filePath: join(dir, 'nope.json'), codec: fakeCodec() })).toBeNull()
  })

  it.each([
    ['JSON 解析不了', '{ 这不是 JSON'],
    [
      '版本号不认识',
      JSON.stringify({ version: 99, model: null, baseUrl: null, apiKeyEncrypted: null })
    ],
    [
      '字段类型不对',
      JSON.stringify({ version: 1, model: 42, baseUrl: null, apiKeyEncrypted: null })
    ],
    ['顶层是数组', JSON.stringify([1, 2, 3])]
  ])('%s → null，坏文件不抛异常', (_label, raw) => {
    writeFileSync(filePath, raw, 'utf8')

    expect(loadModelSettings({ filePath, codec: fakeCodec() })).toBeNull()
  })

  it('密文解不开（换了机器 / 换了用户）→ 整份 null，不是只丢 Key', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        model: 'gpt-4o-mini',
        baseUrl: null,
        apiKeyEncrypted: 'dpapi:别的用户写的'
      }),
      'utf8'
    )

    expect(loadModelSettings({ filePath, codec: fakeCodec() })).toBeNull()
  })

  it('密钥库不可用时保存 Key → ENCRYPTION_UNAVAILABLE，且文件不出现在盘上', () => {
    const error = catchError(() =>
      saveModelSettings(
        { model: 'gpt-4o-mini', baseUrl: null, apiKey: SECRET },
        { filePath, codec: fakeCodec(false) }
      )
    )

    expect(error).toBeInstanceOf(SettingsSaveError)
    expect((error as SettingsSaveError).code).toBe(SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE)
    // 整次保存失败：不能出现「model 落盘了、Key 没落盘」的半份配置
    expect(loadModelSettings({ filePath, codec: fakeCodec() })).toBeNull()
  })

  it('密钥库不可用但没填 Key → 照常保存 model / baseUrl', () => {
    saveModelSettings(
      { model: 'gpt-4o-mini', baseUrl: null, apiKey: null },
      { filePath, codec: fakeCodec(false) }
    )

    expect(loadModelSettings({ filePath, codec: fakeCodec() })).toEqual({
      model: 'gpt-4o-mini',
      baseUrl: null,
      apiKey: null
    })
  })

  it('目录不存在时自动建（userData 存在，但测试与首启路径不能假设它）', () => {
    const nested = join(dir, 'a', 'b', 'model-settings.json')

    saveModelSettings(
      { model: 'm', baseUrl: null, apiKey: null },
      { filePath: nested, codec: fakeCodec() }
    )

    expect(loadModelSettings({ filePath: nested, codec: fakeCodec() })).toEqual({
      model: 'm',
      baseUrl: null,
      apiKey: null
    })
  })
})

describe('buildRuntimeEnv（陪练点）', () => {
  const INHERITED: NodeJS.ProcessEnv = {
    PATH: 'C:\\Windows\\system32',
    SystemRoot: 'C:\\Windows',
    OPENAI_MODEL: 'gpt-4o'
  }

  const SAVED: ModelSettings = {
    model: 'gpt-4o-mini',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: SECRET
  }

  it('settings 为 null：整份拷贝继承环境，且是新对象', () => {
    const env = buildRuntimeEnv(INHERITED, null)

    expect(env).toEqual(INHERITED)
    expect(env).not.toBe(INHERITED)
  })

  it('改动返回值不污染继承环境（拷贝的是环境本身，不是引用）', () => {
    const env = buildRuntimeEnv(INHERITED, null)

    env[API_KEY_ENV_KEY] = 'mutated'

    expect(INHERITED[API_KEY_ENV_KEY]).toBeUndefined()
  })

  it('三个字段齐备：逐字段覆盖，继承里的同名值被换掉', () => {
    const env = buildRuntimeEnv(INHERITED, SAVED)

    expect(env[MODEL_ENV_KEY]).toBe('gpt-4o-mini')
    expect(env[BASE_URL_ENV_KEY]).toBe('https://relay.example.com/v1')
    expect(env[API_KEY_ENV_KEY]).toBe(SECRET)
  })

  it('设置的 null 字段不注入：继承值原样保留（开发态 shell 的 export 照旧可用）', () => {
    const env = buildRuntimeEnv(INHERITED, { model: null, baseUrl: null, apiKey: null })

    expect(env[MODEL_ENV_KEY]).toBe('gpt-4o')
    expect(env[BASE_URL_ENV_KEY]).toBeUndefined()
    expect(env[API_KEY_ENV_KEY]).toBeUndefined()
  })

  it('部分设置：只覆盖填了的字段，其余保留继承值', () => {
    const env = buildRuntimeEnv(INHERITED, {
      model: null,
      baseUrl: 'https://relay/v1',
      apiKey: SECRET
    })

    expect(env[MODEL_ENV_KEY]).toBe('gpt-4o')
    expect(env[BASE_URL_ENV_KEY]).toBe('https://relay/v1')
    expect(env[API_KEY_ENV_KEY]).toBe(SECRET)
  })

  it('继承环境里有 PERSONAL_AGENT_SCRIPT：三个 OPENAI_* 一个都不动（剧本压过设置）', () => {
    const inherited: NodeJS.ProcessEnv = {
      ...INHERITED,
      [SCRIPT_ENV_KEY]: 'C:\\demo\\script.json'
    }

    const env = buildRuntimeEnv(inherited, SAVED)

    expect(env[MODEL_ENV_KEY]).toBe('gpt-4o')
    expect(env[BASE_URL_ENV_KEY]).toBeUndefined()
    expect(env[API_KEY_ENV_KEY]).toBeUndefined()
    expect(env[SCRIPT_ENV_KEY]).toBe('C:\\demo\\script.json')
  })

  it('空串的剧本变量不算剧本模式（空串按没设处理）', () => {
    const env = buildRuntimeEnv({ ...INHERITED, [SCRIPT_ENV_KEY]: '' }, SAVED)

    expect(env[MODEL_ENV_KEY]).toBe('gpt-4o-mini')
    expect(env[API_KEY_ENV_KEY]).toBe(SECRET)
  })

  it('设置里的空串字段不注入，也不产生空串的 OPENAI_*', () => {
    const env = buildRuntimeEnv(INHERITED, { model: '  ', baseUrl: '', apiKey: '' })

    expect(env[MODEL_ENV_KEY]).toBe('gpt-4o')
    expect(env[BASE_URL_ENV_KEY]).toBeUndefined()
    expect(env[API_KEY_ENV_KEY]).toBeUndefined()
  })

  it('任何分支都带上继承环境里的非 OPENAI 变量（spawn 的 env 是整份替换）', () => {
    const env = buildRuntimeEnv(INHERITED, SAVED)

    expect(env.PATH).toBe('C:\\Windows\\system32')
    expect(env.SystemRoot).toBe('C:\\Windows')
  })
})
