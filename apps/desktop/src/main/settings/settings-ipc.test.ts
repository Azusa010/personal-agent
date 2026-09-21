/**
 * 设置通道的入参收窄、合并语义与重启结局（TASK-030）。
 *
 * 存储与重启都是注入的假实现，本文件不碰文件系统、不碰 electron。
 * 「get 结果里不含 Key 明文」是契约底线（SEC-008），断言由 AI 保留，不随陪练交出。
 */
import { describe, expect, it, vi } from 'vitest'

import { ERROR_CODE } from '@personal-agent/protocol'

import { SETTINGS_ERROR_CODE } from './error-code'
import { SettingsSaveError, type ModelSettings, type ModelSettingsStore } from './model-settings'
import {
  getModelSettingsView,
  setModelSettings,
  type RuntimeRestartPort,
  type SettingsIpcDeps
} from './settings-ipc'

const SECRET = 'sk-secret-key-0123456789'

const SAVED: ModelSettings = {
  model: 'gpt-4o-mini',
  baseUrl: 'https://relay.example.com/v1',
  apiKey: SECRET,
  apiProtocol: 'responses'
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
  it('没配过 → 四个字段都空，apiKeySet 为 false', () => {
    const { deps } = fakeDeps({ current: null })

    expect(getModelSettingsView(deps)).toEqual({
      ok: true,
      settings: { apiKeySet: false, model: null, baseUrl: null, apiProtocol: null }
    })
  })

  it('配置过 → model / baseUrl / apiProtocol 回给面板，apiKey 只回「配没配」', () => {
    const { deps } = fakeDeps({ current: SAVED })

    const result = getModelSettingsView(deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settings).toEqual({
      apiKeySet: true,
      model: 'gpt-4o-mini',
      baseUrl: 'https://relay.example.com/v1',
      apiProtocol: 'responses'
    })
  })

  // 契约底线（SEC-008）：Key 明文不出主进程。断言由 AI 保留，不随陪练交出。
  it('契约底线：整个返回体序列化后搜不到 Key 明文', () => {
    const { deps } = fakeDeps({ current: SAVED })

    const result = getModelSettingsView(deps)

    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('只存了 model、没存 Key → apiKeySet 为 false', () => {
    const { deps } = fakeDeps({
      current: { model: 'm', baseUrl: null, apiKey: null, apiProtocol: null }
    })

    const result = getModelSettingsView(deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settings.apiKeySet).toBe(false)
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
    ['clearApiKey 是字符串', { clearApiKey: 'yes' }]
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
})

describe('setModelSettings: 合并语义', () => {
  it('只给 model：另外三个字段保持原值（面板留空 = 没改）', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ model: 'gpt-4.1-mini' }, deps)

    expect(store.save).toHaveBeenCalledWith({
      model: 'gpt-4.1-mini',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: SECRET,
      apiProtocol: 'responses'
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

  it('model 传 null：清空该字段', async () => {
    const { deps, store } = fakeDeps({ current: SAVED })

    await setModelSettings({ model: null }, deps)

    expect(store.save).toHaveBeenCalledWith({ ...SAVED, model: null })
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
      apiProtocol: null
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
