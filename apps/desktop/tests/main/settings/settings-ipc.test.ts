/**
 * 设置通道的入参收窄、合并语义与重启结局（TASK-030）。
 *
 * 存储与重启都是注入的假实现，本文件不碰文件系统、不碰 electron。
 * 「get 结果里不含 Key 明文」是契约底线（SEC-008），断言由 AI 保留，不随陪练交出。
 */
import { describe, expect, it, vi } from 'vitest'

import { ERROR_CODE } from '@personal-agent/protocol'

import { SETTINGS_ERROR_CODE } from '../../../src/main/settings/error-code'
import {
  SettingsSaveError,
  type ModelSettings,
  type ModelSettingsStore
} from '../../../src/main/settings/model-settings'
import {
  getModelSettingsView,
  setModelSettings,
  type RuntimeRestartPort,
  type SettingsIpcDeps
} from '../../../src/main/settings/settings-ipc'

const SECRET = 'sk-secret-key-0123456789'
const TS_SECRET = 'ts-secret-key-0123456789'
const MINERU_SECRET = 'mineru-secret-key-0123456789'
const PG_SECRET = 'pg-password-123'
const TVLY_SECRET = 'tvly-secret-key-0123456789'
const SIDECAR_SECRET = 'sidecar-secret-key-0123456789'
const SIDECAR_JEV_SECRET = 'sidecar-jev-secret-key-0123456789'

const SAVED: ModelSettings = {
  model: 'gpt-4o-mini',
  baseUrl: 'https://relay.example.com/v1',
  apiKey: SECRET,
  apiProtocol: 'responses',
  typesafeApiKey: TS_SECRET,
  typesafeModel: 'jev-planner-v1',
  typesafeBaseUrl: 'https://relay.example.com/typesafe/v1',
  contextWindow: 128000,
  mineruApiUrl: 'https://mineru.example.com/api/v4',
  mineruApiKey: MINERU_SECRET,
  bgeM3Path: '/models/bge-m3',
  bgeRerankerPath: '/models/bge-reranker',
  proposerModel: 'gpt-4o',
  reviewerModel: 'claude-3-5-sonnet',
  postgresHost: '127.0.0.1',
  postgresPort: 5432,
  postgresUser: 'postgres',
  postgresPassword: PG_SECRET,
  postgresDatabase: 'personal_agent',
  vikingStoreRoot: '/data/viking_store',
  tavilyApiKey: TVLY_SECRET,
  tavilyEndpoint: 'https://api.tavily.com/search',
  sidecarModel: 'gpt-4o-mini',
  sidecarBaseUrl: 'https://sidecar.example.com/v1',
  sidecarApiKey: SIDECAR_SECRET,
  sidecarJevModel: 'jev-system-one-v1',
  sidecarJevBaseUrl: 'https://typesafe.example.com/v1',
  sidecarJevApiKey: SIDECAR_JEV_SECRET
}

interface FakeOptions {
  current?: ModelSettings | null
  loadThrows?: Error
  saveThrows?: unknown
  restart?: () => Promise<{ restarted: boolean }>
}

// 每个 stub 都显式标返回类型：不标的话 vi.fn 会把 ok:true 推成 boolean，
// 判别联合就匹不上了（同 permission-ipc.test.ts 的写法）。
function fakeDeps(options: FakeOptions = {}): {
  deps: SettingsIpcDeps
  store: ModelSettingsStore
  runtime: RuntimeRestartPort
} {
  const store: ModelSettingsStore = {
    load: vi.fn((): ModelSettings | null => {
      if (options.loadThrows !== undefined) throw options.loadThrows
      return options.current ?? null
    }),
    save: vi.fn((): void => {
      if (options.saveThrows !== undefined) throw options.saveThrows
    })
  }
  const runtime: RuntimeRestartPort = {
    restart: vi.fn(
      options.restart ?? (async (): Promise<{ restarted: boolean }> => ({ restarted: true }))
    )
  }
  return { deps: { store, runtime }, store, runtime }
}

describe('getModelSettingsView', () => {
  it('没配过 → 字段都空，apiKeySet、typesafeApiKeySet 与 mineruApiKeySet 为 false', () => {
    const { deps } = fakeDeps({ current: null })

    expect(getModelSettingsView(deps)).toEqual({
      ok: true,
      settings: {
        apiKeySet: false,
        model: null,
        baseUrl: null,
        apiProtocol: null,
        typesafeApiKeySet: false,
        typesafeModel: null,
        typesafeBaseUrl: null,
        contextWindow: 128000,
        mineruApiUrl: null,
        mineruApiKeySet: false,
        bgeM3Path: null,
        bgeRerankerPath: null,
        proposerModel: null,
        reviewerModel: null,
        postgresHost: null,
        postgresPort: null,
        postgresUser: null,
        postgresPasswordSet: false,
        postgresDatabase: null,
        vikingStoreRoot: null,
        tavilyApiKeySet: false,
        tavilyEndpoint: null,
        sidecarModel: null,
        sidecarBaseUrl: null,
        sidecarApiKeySet: false,
        sidecarJevModel: null,
        sidecarJevBaseUrl: null,
        sidecarJevApiKeySet: false
      }
    })
  })

  it('配置过 → 模型与地址回给面板，apiKey 与 typesafeApiKey 只回「配没配」', () => {
    const { deps } = fakeDeps({ current: SAVED })

    const result = getModelSettingsView(deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settings).toEqual({
      apiKeySet: true,
      model: 'gpt-4o-mini',
      baseUrl: 'https://relay.example.com/v1',
      apiProtocol: 'responses',
      typesafeApiKeySet: true,
      typesafeModel: 'jev-planner-v1',
      typesafeBaseUrl: 'https://relay.example.com/typesafe/v1',
      contextWindow: 128000,
      mineruApiUrl: 'https://mineru.example.com/api/v4',
      mineruApiKeySet: true,
      bgeM3Path: '/models/bge-m3',
      bgeRerankerPath: '/models/bge-reranker',
      proposerModel: 'gpt-4o',
      reviewerModel: 'claude-3-5-sonnet',
      postgresHost: '127.0.0.1',
      postgresPort: 5432,
      postgresUser: 'postgres',
      postgresPasswordSet: true,
      postgresDatabase: 'personal_agent',
      vikingStoreRoot: '/data/viking_store',
      tavilyApiKeySet: true,
      tavilyEndpoint: 'https://api.tavily.com/search',
      sidecarModel: 'gpt-4o-mini',
      sidecarBaseUrl: 'https://sidecar.example.com/v1',
      sidecarApiKeySet: true,
      sidecarJevModel: 'jev-system-one-v1',
      sidecarJevBaseUrl: 'https://typesafe.example.com/v1',
      sidecarJevApiKeySet: true
    })
  })

  // 契约底线（SEC-008）：Key 明文不出主进程。断言由 AI 保留，不随陪练交出。
  it('契约底线：整个返回体序列化后搜不到任何 Key 明文', () => {
    const { deps } = fakeDeps({ current: SAVED })

    const result = getModelSettingsView(deps)

    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(TS_SECRET)
    expect(JSON.stringify(result)).not.toContain(MINERU_SECRET)
    expect(JSON.stringify(result)).not.toContain(PG_SECRET)
    expect(JSON.stringify(result)).not.toContain(TVLY_SECRET)
    expect(JSON.stringify(result)).not.toContain(SIDECAR_SECRET)
    expect(JSON.stringify(result)).not.toContain(SIDECAR_JEV_SECRET)
  })

  it('只存了 model、没存 Key → apiKeySet 和 typesafeApiKeySet 为 false', () => {
    const { deps } = fakeDeps({
      current: {
        model: 'm',
        baseUrl: null,
        apiKey: null,
        apiProtocol: null,
        typesafeApiKey: null,
        typesafeModel: 'jev-v1',
        typesafeBaseUrl: null,
        contextWindow: null,
        mineruApiUrl: null,
        mineruApiKey: null
      }
    })

    const result = getModelSettingsView(deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settings.apiKeySet).toBe(false)
    expect(result.settings.typesafeApiKeySet).toBe(false)
    expect(result.settings.mineruApiKeySet).toBe(false)
    expect(result.settings.typesafeModel).toBe('jev-v1')
  })

  it('存储层真抛异常 → READ_FAILED，不装成「未配置」', () => {
    const { deps } = fakeDeps({ loadThrows: new Error('EACCES: permission denied') })

    const result = getModelSettingsView(deps)

    expect(result).toEqual({
      ok: false,
      code: SETTINGS_ERROR_CODE.READ_FAILED,
      message: 'EACCES: permission denied'
    })
  })
})

describe('setModelSettings: 入参收窄', () => {
  const cases: Array<[string, unknown]> = [
    ['不是对象', 'model=gpt-4o'],
    ['是 null', null],
    ['是数组', [{ model: 'm' }]],
    ['model 是数字', { model: 42 }],
    ['baseUrl 是对象', { baseUrl: {} }],
    ['apiKey 是数字', { apiKey: 5 }],
    ['clearApiKey 是字符串', { clearApiKey: 'yes' }],
    ['typesafeApiKey 是数字', { typesafeApiKey: 123 }],
    ['clearTypesafeApiKey 是字符串', { clearTypesafeApiKey: 'yes' }],
    ['typesafeModel 是数字', { typesafeModel: 99 }],
    ['typesafeBaseUrl 是布尔值', { typesafeBaseUrl: true }],
    ['sidecarApiKey 是数字', { sidecarApiKey: 123 }],
    ['clearSidecarApiKey 是字符串', { clearSidecarApiKey: 'yes' }],
    ['sidecarJevApiKey 是数字', { sidecarJevApiKey: 456 }],
    ['clearSidecarJevApiKey 是字符串', { clearSidecarJevApiKey: 'yes' }]
  ]

  it.each(cases)('%s → PROTOCOL_INVALID_REQUEST，且不写存储', async (_label, input) => {
    const { deps, store } = fakeDeps({ current: SAVED })

    const result = await setModelSettings(input, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
    expect(store.save).not.toHaveBeenCalled()
  })

  it('apiKey 类型不对时不把收到的值写进错误消息（那是密钥，消息会进日志）', async () => {
    const { deps } = fakeDeps()

    const result = await setModelSettings({ apiKey: 12345 }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain('12345')
  })

  it('typesafeApiKey 类型不对时不把收到的值写进错误消息（安全边界）', async () => {
    const { deps } = fakeDeps()

    const result = await setModelSettings({ typesafeApiKey: 54321 }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain('54321')
  })

  it('sidecarApiKey 类型不对时不把收到的值写进错误消息（安全边界）', async () => {
    const { deps } = fakeDeps()

    const result = await setModelSettings({ sidecarApiKey: 98765 }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain('98765')
  })

  it('sidecarJevApiKey 类型不对时不把收到的值写进错误消息（安全边界）', async () => {
    const { deps } = fakeDeps()

    const result = await setModelSettings({ sidecarJevApiKey: 65432 }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain('65432')
  })
})

describe('setModelSettings: 合并语义', () => {
  it('只给 model：另外字段保持原值（面板留空 = 没改）', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ model: 'gpt-4.1-mini' }, deps)

    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      model: 'gpt-4.1-mini'
    })
  })

  it('apiKey 是空串：按「没改」处理，旧 Key 不会被清掉', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ apiKey: '' }, deps)

    expect(store.save).toHaveBeenCalledWith({ ...SAVED })
  })

  it('apiKey 给了新值：覆盖旧 Key', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ apiKey: 'sk-brand-new' }, deps)

    expect(store.save).toHaveBeenCalledWith({ ...SAVED, apiKey: 'sk-brand-new' })
  })

  it('clearApiKey 优先于 apiKey 字段：同时给也按清除算', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ clearApiKey: true, apiKey: 'sk-ignored' }, deps)

    expect(store.save).toHaveBeenCalledWith({ ...SAVED, apiKey: null })
  })

  it('typesafeApiKey 是空串：按「没改」处理，旧 Key 不会被清掉', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ typesafeApiKey: '' }, deps)

    expect(store.save).toHaveBeenCalledWith({ ...SAVED })
  })

  it('typesafeApiKey 给了新值：覆盖旧 Key', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ typesafeApiKey: 'ts-brand-new' }, deps)

    expect(store.save).toHaveBeenCalledWith({ ...SAVED, typesafeApiKey: 'ts-brand-new' })
  })

  it('clearTypesafeApiKey 优先于 typesafeApiKey：同时给也按清除算', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ clearTypesafeApiKey: true, typesafeApiKey: 'ts-ignored' }, deps)

    expect(store.save).toHaveBeenCalledWith({ ...SAVED, typesafeApiKey: null })
  })

  it('model 传 null：清空该字段', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ model: null }, deps)

    expect(store.save).toHaveBeenCalledWith({ ...SAVED, model: null })
  })

  it('typesafeModel 与 typesafeBaseUrl 可以更新或清空为 null', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ typesafeModel: 'jev-planner-v2', typesafeBaseUrl: null }, deps)
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      typesafeModel: 'jev-planner-v2',
      typesafeBaseUrl: null
    })
  })

  it('apiProtocol 可以切换为 chat_completions 或清空为 null', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ apiProtocol: 'chat_completions' }, deps)
    expect(store.save).toHaveBeenCalledWith({ ...SAVED, apiProtocol: 'chat_completions' })

    await setModelSettings({ apiProtocol: null }, deps)
    expect(store.save).toHaveBeenCalledWith({ ...SAVED, apiProtocol: null })
  })

  it('从没配过时保存：空基线 + 本次给的字段', async () => {
    const { deps, store } = fakeDeps({ current: null })

    await setModelSettings({ model: 'gpt-4o-mini', apiKey: SECRET }, deps)

    expect(store.save).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      baseUrl: null,
      apiKey: SECRET,
      apiProtocol: null,
      typesafeApiKey: null,
      typesafeModel: null,
      typesafeBaseUrl: null,
      contextWindow: null,
      mineruApiUrl: null,
      mineruApiKey: null,
      bgeM3Path: null,
      bgeRerankerPath: null,
      proposerModel: null,
      reviewerModel: null,
      postgresHost: null,
      postgresPort: null,
      postgresUser: null,
      postgresPassword: null,
      postgresDatabase: null,
      vikingStoreRoot: null,
      tavilyApiKey: null,
      tavilyEndpoint: null,
      sidecarModel: null,
      sidecarBaseUrl: null,
      sidecarApiKey: null,
      sidecarJevModel: null,
      sidecarJevBaseUrl: null,
      sidecarJevApiKey: null
    })
  })

  it('postgresPassword 与 knowledge / storage 配置可以更新或清除', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings(
      {
        postgresPassword: 'new-pg-password',
        postgresHost: 'pg.internal',
        bgeM3Path: '/custom/bge-m3'
      },
      deps
    )
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      postgresPassword: 'new-pg-password',
      postgresHost: 'pg.internal',
      bgeM3Path: '/custom/bge-m3'
    })

    await setModelSettings(
      {
        clearPostgresPassword: true,
        postgresHost: null
      },
      deps
    )
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      postgresPassword: null,
      postgresHost: null
    })
  })

  it('mineruApiKey 与 mineruApiUrl 可以更新或清除', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings(
      { mineruApiKey: 'new-mineru-key', mineruApiUrl: 'https://custom.mineru.com' },
      deps
    )
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      mineruApiKey: 'new-mineru-key',
      mineruApiUrl: 'https://custom.mineru.com'
    })

    await setModelSettings({ clearMineruApiKey: true, mineruApiUrl: null }, deps)
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      mineruApiKey: null,
      mineruApiUrl: null
    })
  })

  it('contextWindow 可以更新为自定义数字或重置为 null', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ contextWindow: 64000 }, deps)
    expect(store.save).toHaveBeenCalledWith({ ...SAVED, contextWindow: 64000 })

    await setModelSettings({ contextWindow: null }, deps)
    expect(store.save).toHaveBeenCalledWith({ ...SAVED, contextWindow: null })
  })

  it('tavilyApiKey 与 tavilyEndpoint 可以更新或清除', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings(
      { tavilyApiKey: 'new-tvly-key', tavilyEndpoint: 'https://custom.tavily.com' },
      deps
    )
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      tavilyApiKey: 'new-tvly-key',
      tavilyEndpoint: 'https://custom.tavily.com'
    })

    await setModelSettings({ clearTavilyApiKey: true, tavilyEndpoint: null }, deps)
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      tavilyApiKey: null,
      tavilyEndpoint: null
    })
  })

  it('sidecar 与 sidecarJev 配置可以更新或清除', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings(
      {
        sidecarModel: 'gpt-4o',
        sidecarBaseUrl: 'https://new-sidecar.com',
        sidecarApiKey: 'new-sidecar-key',
        sidecarJevModel: 'jev-v2',
        sidecarJevBaseUrl: 'https://new-jev.com',
        sidecarJevApiKey: 'new-jev-key'
      },
      deps
    )
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      sidecarModel: 'gpt-4o',
      sidecarBaseUrl: 'https://new-sidecar.com',
      sidecarApiKey: 'new-sidecar-key',
      sidecarJevModel: 'jev-v2',
      sidecarJevBaseUrl: 'https://new-jev.com',
      sidecarJevApiKey: 'new-jev-key'
    })

    await setModelSettings(
      {
        clearSidecarApiKey: true,
        clearSidecarJevApiKey: true,
        sidecarModel: null,
        sidecarJevModel: null
      },
      deps
    )
    expect(store.save).toHaveBeenCalledWith({
      ...SAVED,
      sidecarApiKey: null,
      sidecarJevApiKey: null,
      sidecarModel: null,
      sidecarJevModel: null
    })
  })
})

describe('setModelSettings: 失败与重启结局', () => {
  it('加密不可用 → 原样透传 ENCRYPTION_UNAVAILABLE，且不重启 runtime', async () => {
    const { deps, runtime } = fakeDeps({
      current: null,
      saveThrows: new SettingsSaveError(
        SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
        '系统密钥库不可用，API Key 无法加密保存'
      )
    })

    const result = await setModelSettings({ apiKey: SECRET }, deps)

    expect(result).toEqual({
      ok: false,
      code: SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
      message: '系统密钥库不可用，API Key 无法加密保存'
    })
    expect(runtime.restart).not.toHaveBeenCalled()
  })

  it('存储层抛的不是 SettingsSaveError → 收成 WRITE_FAILED', async () => {
    const { deps, runtime } = fakeDeps({ saveThrows: new Error('ENOSPC: no space left') })

    const result = await setModelSettings({ model: 'm' }, deps)

    expect(result).toEqual({
      ok: false,
      code: SETTINGS_ERROR_CODE.WRITE_FAILED,
      message: 'ENOSPC: no space left'
    })
    expect(runtime.restart).not.toHaveBeenCalled()
  })

  it('读现状就失败 → READ_FAILED，不拿空基线覆盖用户的设置', async () => {
    const { deps, store } = fakeDeps({ loadThrows: new Error('EACCES') })

    const result = await setModelSettings({ model: 'm' }, deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(SETTINGS_ERROR_CODE.READ_FAILED)
    expect(store.save).not.toHaveBeenCalled()
  })

  it('空闲 → 先落盘后重启，applied 是 restarted', async () => {
    const order: string[] = []
    const store: ModelSettingsStore = {
      load: vi.fn((): ModelSettings | null => null),
      save: vi.fn((): void => {
        order.push('save')
      })
    }
    const runtime: RuntimeRestartPort = {
      restart: vi.fn(async (): Promise<{ restarted: boolean }> => {
        order.push('restart')
        return { restarted: true }
      })
    }

    const result = await setModelSettings({ model: 'm' }, { store, runtime })

    expect(result).toEqual({ ok: true, applied: 'restarted' })
    expect(order).toEqual(['save', 'restart'])
  })

  it('有任务在跑（没重启成）→ 设置照样保存，applied 是 on-next-restart', async () => {
    const { deps, store } = fakeDeps({
      current: SAVED,
      restart: async (): Promise<{ restarted: boolean }> => ({ restarted: false })
    })

    const result = await setModelSettings({ model: 'm' }, deps)

    expect(result).toEqual({ ok: true, applied: 'on-next-restart' })
    expect(store.save).toHaveBeenCalledTimes(1)
  })

  it('重启过程本身抛异常 → 仍是 saved：applied 报 on-next-restart，不谎报失败', async () => {
    const { deps, store } = fakeDeps({
      current: SAVED,
      restart: async (): Promise<{ restarted: boolean }> => {
        throw new Error('spawn ENOENT')
      }
    })

    const result = await setModelSettings({ baseUrl: null }, deps)

    expect(result).toEqual({ ok: true, applied: 'on-next-restart' })
    expect(store.save).toHaveBeenCalledWith({ ...SAVED, baseUrl: null })
  })
})
