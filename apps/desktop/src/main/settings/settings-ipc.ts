import { z } from 'zod'

import { ERROR_CODE } from '@personal-agent/protocol'

import type {
  GetModelSettingsResult,
  IpcErrorCode,
  SetModelSettingsResult
} from '../../shared/ipc-contract'
import { SETTINGS_ERROR_CODE } from './error-code'
import { SettingsSaveError, type ModelSettings, type ModelSettingsStore } from './model-settings'

/** 设置面板保存后要重启 runtime 才能让新配置生效（Python 启动时读一次 env）。
 *  这是真实实现（runtime-host.restartRuntime）与测试假实现的分界。 */
export interface RuntimeRestartPort {
  /** restarted=false 表示没有重启（当前有任务在跑），配置留到下次启动生效。 */
  restart(): Promise<{ restarted: boolean }>
}

export interface SettingsIpcDeps {
  store: ModelSettingsStore
  runtime: RuntimeRestartPort
}

/**
 * 入参契约。字段语义：
 * - model / baseUrl：不给 = 保持不变；null 或空白串 = 清空；字符串 = 新值。
 * - apiKey：不给或空串 = 保持不变（面板不回显明文，留空就是「没改」）；
 *   清空走显式的 clearApiKey。
 */
const SetSettingsInput = z.object({
  model: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  // 不把收到的值写进错误消息：这是密钥，出错信息会进日志（SEC-008）
  apiKey: z.string('apiKey 必须是字符串').optional(),
  clearApiKey: z.boolean('clearApiKey 必须是布尔值').optional(),
  apiProtocol: z.enum(['responses', 'chat_completions']).nullable().optional(),
  typesafeApiKey: z.string('typesafeApiKey 必须是字符串').optional(),
  clearTypesafeApiKey: z.boolean('clearTypesafeApiKey 必须是布尔值').optional(),
  typesafeModel: z.string().nullable().optional(),
  typesafeBaseUrl: z.string().nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  mineruApiUrl: z.string().nullable().optional(),
  mineruApiKey: z.string('mineruApiKey 必须是字符串').optional(),
  clearMineruApiKey: z.boolean('clearMineruApiKey 必须是布尔值').optional(),
  bgeM3Path: z.string().nullable().optional(),
  bgeRerankerPath: z.string().nullable().optional(),
  proposerModel: z.string().nullable().optional(),
  reviewerModel: z.string().nullable().optional(),
  postgresHost: z.string().nullable().optional(),
  postgresPort: z.number().int().positive().nullable().optional(),
  postgresUser: z.string().nullable().optional(),
  postgresPassword: z.string('postgresPassword 必须是字符串').optional(),
  clearPostgresPassword: z.boolean('clearPostgresPassword 必须是布尔值').optional(),
  postgresDatabase: z.string().nullable().optional(),
  vikingStoreRoot: z.string().nullable().optional(),
  tavilyApiKey: z.string('tavilyApiKey 必须是字符串').optional(),
  clearTavilyApiKey: z.boolean('clearTavilyApiKey 必须是布尔值').optional(),
  tavilyEndpoint: z.string().nullable().optional(),
  sidecarModel: z.string().nullable().optional(),
  sidecarBaseUrl: z.string().nullable().optional(),
  sidecarApiKey: z.string('sidecarApiKey 必须是字符串').optional(),
  clearSidecarApiKey: z.boolean('clearSidecarApiKey 必须是布尔值').optional(),
  sidecarJevModel: z.string().nullable().optional(),
  sidecarJevBaseUrl: z.string().nullable().optional(),
  sidecarJevApiKey: z.string('sidecarJevApiKey 必须是字符串').optional(),
  clearSidecarJevApiKey: z.boolean('clearSidecarJevApiKey 必须是布尔值').optional()
})

const EMPTY_SETTINGS: ModelSettings = {
  model: null,
  baseUrl: null,
  apiKey: null,
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
}

function invalid(message: string): { ok: false; code: IpcErrorCode; message: string } {
  return { ok: false, code: ERROR_CODE.PROTOCOL_INVALID_REQUEST, message }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 读设置面板要显示的现状。**永不回传 Key 明文** ：只给「配没配」的布尔值。
 * 面板据此显示「已配置，留空保持不变」。
 */
export function getModelSettingsView(deps: SettingsIpcDeps): GetModelSettingsResult {
  let settings: ModelSettings | null
  try {
    settings = deps.store.load()
  } catch (e) {
    // load 的实现契约是「失败返回 null」，真抛了说明存储层坏了：
    // 如实报出来，不装成「未配置」——那会把用户引到错误的方向。
    return { ok: false, code: SETTINGS_ERROR_CODE.READ_FAILED, message: describe(e) }
  }

  return {
    ok: true,
    settings: {
      apiKeySet: settings !== null && settings.apiKey !== null,
      model: settings?.model ?? null,
      baseUrl: settings?.baseUrl ?? null,
      apiProtocol: settings?.apiProtocol ?? null,
      typesafeApiKeySet: settings !== null && settings.typesafeApiKey !== null,
      typesafeModel: settings?.typesafeModel ?? null,
      typesafeBaseUrl: settings?.typesafeBaseUrl ?? null,
      contextWindow: settings?.contextWindow ?? 128000,
      mineruApiUrl: settings?.mineruApiUrl ?? null,
      mineruApiKeySet: settings !== null && settings.mineruApiKey !== null,
      bgeM3Path: settings?.bgeM3Path ?? null,
      bgeRerankerPath: settings?.bgeRerankerPath ?? null,
      proposerModel: settings?.proposerModel ?? null,
      reviewerModel: settings?.reviewerModel ?? null,
      postgresHost: settings?.postgresHost ?? null,
      postgresPort: settings?.postgresPort ?? null,
      postgresUser: settings?.postgresUser ?? null,
      postgresDatabase: settings?.postgresDatabase ?? null,
      postgresPasswordSet: settings !== null && Boolean(settings.postgresPassword),
      vikingStoreRoot: settings?.vikingStoreRoot ?? null,
      tavilyApiKeySet: settings !== null && Boolean(settings.tavilyApiKey),
      tavilyEndpoint: settings?.tavilyEndpoint ?? null,
      sidecarModel: settings?.sidecarModel ?? null,
      sidecarBaseUrl: settings?.sidecarBaseUrl ?? null,
      sidecarApiKeySet: settings !== null && Boolean(settings.sidecarApiKey),
      sidecarJevModel: settings?.sidecarJevModel ?? null,
      sidecarJevBaseUrl: settings?.sidecarJevBaseUrl ?? null,
      sidecarJevApiKeySet: settings !== null && Boolean(settings.sidecarJevApiKey)
    }
  }
}

/**
 * 保存设置并在条件允许时重启 runtime 让新配置生效。入参来自 renderer，一律不可信。
 *
 * 顺序固定为「先落盘、后重启」：重启失败（或没做成）不改变「设置已保存」这个事实，
 * 只是生效时间推后——返回体里的 applied 如实区分这两种结局。
 */
export async function setModelSettings(
  input: unknown,
  deps: SettingsIpcDeps
): Promise<SetModelSettingsResult> {
  const parsed = SetSettingsInput.safeParse(input)
  if (!parsed.success) {
    return invalid(`设置参数不符合契约: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }
  const patch = parsed.data

  let current: ModelSettings
  try {
    current = deps.store.load() ?? { ...EMPTY_SETTINGS }
  } catch (e) {
    return { ok: false, code: SETTINGS_ERROR_CODE.READ_FAILED, message: describe(e) }
  }

  const next: ModelSettings = { ...current }
  if (patch.model !== undefined) next.model = patch.model
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl
  if (patch.clearApiKey === true) {
    next.apiKey = null
  } else if (patch.apiKey !== undefined && patch.apiKey.trim() !== '') {
    next.apiKey = patch.apiKey
  }
  if (patch.apiProtocol !== undefined) {
    next.apiProtocol = patch.apiProtocol
  }

  if (patch.clearTypesafeApiKey === true) {
    next.typesafeApiKey = null
  } else if (patch.typesafeApiKey !== undefined && patch.typesafeApiKey.trim() !== '') {
    next.typesafeApiKey = patch.typesafeApiKey
  }
  if (patch.typesafeModel !== undefined) next.typesafeModel = patch.typesafeModel
  if (patch.typesafeBaseUrl !== undefined) next.typesafeBaseUrl = patch.typesafeBaseUrl
  if (patch.contextWindow !== undefined) next.contextWindow = patch.contextWindow

  if (patch.clearMineruApiKey === true) {
    next.mineruApiKey = null
  } else if (patch.mineruApiKey !== undefined && patch.mineruApiKey.trim() !== '') {
    next.mineruApiKey = patch.mineruApiKey
  }
  if (patch.mineruApiUrl !== undefined) next.mineruApiUrl = patch.mineruApiUrl

  if (patch.bgeM3Path !== undefined) next.bgeM3Path = patch.bgeM3Path
  if (patch.bgeRerankerPath !== undefined) next.bgeRerankerPath = patch.bgeRerankerPath
  if (patch.proposerModel !== undefined) next.proposerModel = patch.proposerModel
  if (patch.reviewerModel !== undefined) next.reviewerModel = patch.reviewerModel

  if (patch.postgresHost !== undefined) next.postgresHost = patch.postgresHost
  if (patch.postgresPort !== undefined) next.postgresPort = patch.postgresPort
  if (patch.postgresUser !== undefined) next.postgresUser = patch.postgresUser
  if (patch.clearPostgresPassword === true) {
    next.postgresPassword = null
  } else if (patch.postgresPassword !== undefined && patch.postgresPassword.trim() !== '') {
    next.postgresPassword = patch.postgresPassword
  }
  if (patch.postgresDatabase !== undefined) next.postgresDatabase = patch.postgresDatabase

  if (patch.vikingStoreRoot !== undefined) next.vikingStoreRoot = patch.vikingStoreRoot

  if (patch.clearTavilyApiKey === true) {
    next.tavilyApiKey = null
    delete process.env.TAVILY_API_KEY
  } else if (patch.tavilyApiKey !== undefined && patch.tavilyApiKey.trim() !== '') {
    next.tavilyApiKey = patch.tavilyApiKey
    process.env.TAVILY_API_KEY = next.tavilyApiKey
  }
  if (patch.tavilyEndpoint !== undefined) {
    next.tavilyEndpoint = patch.tavilyEndpoint
    if (next.tavilyEndpoint) {
      process.env.TAVILY_ENDPOINT = next.tavilyEndpoint
    } else {
      delete process.env.TAVILY_ENDPOINT
    }
  }

  if (patch.sidecarModel !== undefined) next.sidecarModel = patch.sidecarModel
  if (patch.sidecarBaseUrl !== undefined) next.sidecarBaseUrl = patch.sidecarBaseUrl
  if (patch.clearSidecarApiKey === true) {
    next.sidecarApiKey = null
  } else if (patch.sidecarApiKey !== undefined && patch.sidecarApiKey.trim() !== '') {
    next.sidecarApiKey = patch.sidecarApiKey
  }

  if (patch.sidecarJevModel !== undefined) next.sidecarJevModel = patch.sidecarJevModel
  if (patch.sidecarJevBaseUrl !== undefined) next.sidecarJevBaseUrl = patch.sidecarJevBaseUrl
  if (patch.clearSidecarJevApiKey === true) {
    next.sidecarJevApiKey = null
  } else if (patch.sidecarJevApiKey !== undefined && patch.sidecarJevApiKey.trim() !== '') {
    next.sidecarJevApiKey = patch.sidecarJevApiKey
  }

  try {
    deps.store.save(next)
  } catch (e) {
    if (e instanceof SettingsSaveError) return { ok: false, code: e.code, message: e.message }
    return { ok: false, code: SETTINGS_ERROR_CODE.WRITE_FAILED, message: describe(e) }
  }

  // 设置已经落盘了。重启是「让配置生效」，不是保存的一部分：
  // 有任务在跑就不打断（restarted=false），重启本身出意外也按同一结局处理。
  let restarted = false
  try {
    restarted = (await deps.runtime.restart()).restarted
  } catch (e) {
    console.error('[settings] runtime 重启失败，设置留到下次启动生效', e)
  }

  return { ok: true, applied: restarted ? 'restarted' : 'on-next-restart' }
}
