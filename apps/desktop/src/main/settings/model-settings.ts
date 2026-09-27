import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SETTINGS_ERROR_CODE } from './error-code'

export const API_PROTOCOL_ENV_KEY = 'OPENAI_API_PROTOCOL'

export const TYPESAFE_API_KEY_ENV_KEY = 'TYPESAFE_API_KEY'
export const TYPESAFE_MODEL_ENV_KEY = 'TYPESAFE_DEFAULT_MODEL'
export const TYPESAFE_BASE_URL_ENV_KEY = 'TYPESAFE_BASE_URL'
export const CONTEXT_WINDOW_ENV_KEY = 'PERSONAL_AGENT_MAX_WINDOW_TOKENS'

export const MINERU_API_URL_ENV_KEY = 'MINERU_API_URL'
export const MINERU_API_KEY_ENV_KEY = 'MINERU_API_KEY'

export const BGE_M3_PATH_ENV_KEY = 'BGE_M3_PATH'
export const BGE_RERANKER_PATH_ENV_KEY = 'BGE_RERANKER_PATH'
export const PROPOSER_MODEL_ENV_KEY = 'PERSONAL_AGENT_PROPOSER_MODEL'
export const REVIEWER_MODEL_ENV_KEY = 'PERSONAL_AGENT_REVIEWER_MODEL'
export const POSTGRES_HOST_ENV_KEY = 'POSTGRES_HOST'
export const POSTGRES_PORT_ENV_KEY = 'POSTGRES_PORT'
export const POSTGRES_USER_ENV_KEY = 'POSTGRES_USER'
export const POSTGRES_PASSWORD_ENV_KEY = 'POSTGRES_PASSWORD'
export const POSTGRES_DB_ENV_KEY = 'POSTGRES_DB'
export const VIKING_ROOT_ENV_KEY = 'PERSONAL_AGENT_VIKING_ROOT'
export const TAVILY_API_KEY_ENV_KEY = 'TAVILY_API_KEY'
export const TAVILY_ENDPOINT_ENV_KEY = 'TAVILY_ENDPOINT'

export const SIDECAR_MODEL_ENV_KEY = 'PERSONAL_AGENT_SIDECAR_MODEL'
export const SIDECAR_API_KEY_ENV_KEY = 'PERSONAL_AGENT_SIDECAR_API_KEY'
export const SIDECAR_BASE_URL_ENV_KEY = 'PERSONAL_AGENT_SIDECAR_BASE_URL'

export const SIDECAR_JEV_MODEL_ENV_KEY = 'PERSONAL_AGENT_SIDECAR_JEV_MODEL'
export const SIDECAR_JEV_API_KEY_ENV_KEY = 'PERSONAL_AGENT_SIDECAR_JEV_API_KEY'
export const SIDECAR_JEV_BASE_URL_ENV_KEY = 'PERSONAL_AGENT_SIDECAR_JEV_BASE_URL'

/** 用户级模型配置的内存形状。apiKey 和 typesafeApiKey 是解密后的明文，只允许活在主进程
 *  字段可变：设置面板是「读出现状 → 改了哪几个字段 → 整体回写」，
 *  与 shared/domain.ts 的 TaskRecord / PermissionRecord 同一种写法。 */
export interface ModelSettings {
  model: string | null
  baseUrl: string | null
  apiKey: string | null
  apiProtocol: 'responses' | 'chat_completions' | null
  typesafeApiKey: string | null
  typesafeModel: string | null
  typesafeBaseUrl: string | null
  contextWindow: number | null
  mineruApiUrl: string | null
  mineruApiKey: string | null
  bgeM3Path?: string | null
  bgeRerankerPath?: string | null
  proposerModel?: string | null
  reviewerModel?: string | null
  postgresHost?: string | null
  postgresPort?: number | null
  postgresUser?: string | null
  postgresPassword?: string | null
  postgresDatabase?: string | null
  vikingStoreRoot?: string | null
  tavilyApiKey?: string | null
  tavilyEndpoint?: string | null
  sidecarModel?: string | null
  sidecarBaseUrl?: string | null
  sidecarApiKey?: string | null
  sidecarJevModel?: string | null
  sidecarJevBaseUrl?: string | null
  sidecarJevApiKey?: string | null
}

/** settings 文件在 userData 下的文件名。 */
export const SETTINGS_FILE_NAME = 'model-settings.json'

/** 文件格式版本。读到的版本不是它，整份按「未配置」处理——宁可让用户重填，
 *  也不猜一个结构对不上的文件。 */
export const SETTINGS_VERSION = 1

/** 子进程环境里与模型相关的键名。TS / Python 两侧是钉值重复的字面量
 *  改一边必须改另一边。 */
export const MODEL_ENV_KEY = 'OPENAI_MODEL'
export const API_KEY_ENV_KEY = 'OPENAI_API_KEY'
export const BASE_URL_ENV_KEY = 'OPENAI_BASE_URL'

/** 剧本模式开关：设了它 = 本次启动显式指定走剧本（演示脚本、CI、E2E）。 */
export const SCRIPT_ENV_KEY = 'PERSONAL_AGENT_SCRIPT'

/** 落盘形状。apiKey 与 typesafeApiKey 只存密文（base64），明文绝不进文件。 */
interface StoredSettings {
  version: number
  model: string | null
  baseUrl: string | null
  apiKeyEncrypted: string | null
  apiProtocol: 'responses' | 'chat_completions' | null
  typesafeApiKeyEncrypted?: string | null
  typesafeModel?: string | null
  typesafeBaseUrl?: string | null
  contextWindow?: number | null
  mineruApiUrl?: string | null
  mineruApiKeyEncrypted?: string | null
  bgeM3Path?: string | null
  bgeRerankerPath?: string | null
  proposerModel?: string | null
  reviewerModel?: string | null
  postgresHost?: string | null
  postgresPort?: number | null
  postgresUser?: string | null
  postgresPasswordEncrypted?: string | null
  postgresDatabase?: string | null
  vikingStoreRoot?: string | null
  tavilyApiKeyEncrypted?: string | null
  tavilyEndpoint?: string | null
  sidecarModel?: string | null
  sidecarBaseUrl?: string | null
  sidecarApiKeyEncrypted?: string | null
  sidecarJevModel?: string | null
  sidecarJevBaseUrl?: string | null
  sidecarJevApiKeyEncrypted?: string | null
}

/** 系统密钥库的薄封装。生产接线是 Electron safeStorage（Windows 走 DPAPI，密文
 *  只有当前用户能解），单测里是可逆的假实现——本模块不 import electron，
 *  才能不起真实例被测，也让「加密不可用」「密文解不开」这些分支可被构造。 */
export interface SecretCodec {
  isAvailable(): boolean
  /** 明文 → base64 密文 */
  encrypt(plain: string): string
  /** base64 密文 → 明文；密文不可解时抛 */
  decrypt(encrypted: string): string
}

export interface ModelSettingsStoreDeps {
  /** settings 文件的绝对路径（生产是 userData/model-settings.json） */
  filePath: string
  codec: SecretCodec
}

export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODE)[keyof typeof SETTINGS_ERROR_CODE]

/** 设置存储的窄接口：settings-ipc 只认这两个方法，真实实现（文件 + safeStorage）
 *  与测试里的假实现可以互换。save 失败抛 SettingsSaveError。 */
export interface ModelSettingsStore {
  load(): ModelSettings | null
  save(settings: ModelSettings): void
}

/** 保存失败。code 直接对应 SETTINGS_ERROR_CODE 的值，settings-ipc 原样映射给 UI。 */
export class SettingsSaveError extends Error {
  constructor(
    readonly code: SettingsErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SettingsSaveError'
  }
}

/** 空串与空白按「未设置」处理：设置面板里删干净输入框、环境变量里设成空串，
 *  在 Python 侧 os.environ.get 眼里都是假值，两侧语义必须一致。 */
function normalize(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 读不到 / 解析失败 / 字段类型不对时返回 undefined（与「合法的 null」区分开）。 */
function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  return undefined
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 读取设置。任何读取 / 解析 / 解密失败都收成 null（=「未配置」），绝不让设置文件
 * 挡住 app 启动：文件是给人看的，手改坏是常态，坏文件的处置是回到默认行为。
 *
 * 整份失败而不是逐字段降级：面板显示的值与运行时实际用的值必须一致。
 * 逐字段降级会出现「面板里有 model、运行时用的是残缺配置」这种看不出所以然的组合。
 */
export function loadModelSettings(deps: ModelSettingsStoreDeps): ModelSettings | null {
  let raw: string
  try {
    raw = readFileSync(deps.filePath, 'utf8')
  } catch {
    return null // 文件不存在 = 从没配过
  }

  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }
  if (stored === null || typeof stored !== 'object') return null

  const record = stored as Record<string, unknown>
  if (record.version !== SETTINGS_VERSION) return null

  const model = asNullableString(record.model)
  const baseUrl = asNullableString(record.baseUrl)
  const apiKeyEncrypted = asNullableString(record.apiKeyEncrypted)
  if (model === undefined || baseUrl === undefined || apiKeyEncrypted === undefined) return null

  let apiKey: string | null = null
  if (apiKeyEncrypted !== null) {
    if (!deps.codec.isAvailable()) return null
    try {
      apiKey = deps.codec.decrypt(apiKeyEncrypted)
    } catch {
      return null
    }
  }

  let apiProtocol: 'responses' | 'chat_completions' | null = null
  if (record.apiProtocol === 'responses' || record.apiProtocol === 'chat_completions') {
    apiProtocol = record.apiProtocol
  } else if (record.apiProtocol !== null && record.apiProtocol !== undefined) {
    return null
  }

  const typesafeModel = asNullableString(record.typesafeModel) ?? null
  const typesafeBaseUrl = asNullableString(record.typesafeBaseUrl) ?? null
  const typesafeApiKeyEncrypted = asNullableString(record.typesafeApiKeyEncrypted) ?? null

  let typesafeApiKey: string | null = null
  if (typesafeApiKeyEncrypted !== null) {
    if (!deps.codec.isAvailable()) return null
    try {
      typesafeApiKey = deps.codec.decrypt(typesafeApiKeyEncrypted)
    } catch {
      return null
    }
  }

  const mineruApiUrl = asNullableString(record.mineruApiUrl) ?? null
  const mineruApiKeyEncrypted = asNullableString(record.mineruApiKeyEncrypted) ?? null

  let mineruApiKey: string | null = null
  if (mineruApiKeyEncrypted !== null) {
    if (!deps.codec.isAvailable()) return null
    try {
      mineruApiKey = deps.codec.decrypt(mineruApiKeyEncrypted)
    } catch {
      return null
    }
  }

  const contextWindow =
    typeof record.contextWindow === 'number' &&
    Number.isInteger(record.contextWindow) &&
    record.contextWindow > 0
      ? record.contextWindow
      : null

  const bgeM3Path = asNullableString(record.bgeM3Path) ?? null
  const bgeRerankerPath = asNullableString(record.bgeRerankerPath) ?? null
  const proposerModel = asNullableString(record.proposerModel) ?? null
  const reviewerModel = asNullableString(record.reviewerModel) ?? null
  const postgresHost = asNullableString(record.postgresHost) ?? null
  const postgresPort =
    typeof record.postgresPort === 'number' &&
    Number.isInteger(record.postgresPort) &&
    record.postgresPort > 0
      ? record.postgresPort
      : null
  const postgresUser = asNullableString(record.postgresUser) ?? null
  const postgresDatabase = asNullableString(record.postgresDatabase) ?? null
  const vikingStoreRoot = asNullableString(record.vikingStoreRoot) ?? null

  const postgresPasswordEncrypted = asNullableString(record.postgresPasswordEncrypted) ?? null
  let postgresPassword: string | null = null
  if (postgresPasswordEncrypted !== null) {
    if (!deps.codec.isAvailable()) return null
    try {
      postgresPassword = deps.codec.decrypt(postgresPasswordEncrypted)
    } catch {
      return null
    }
  }

  const tavilyEndpoint = asNullableString(record.tavilyEndpoint) ?? null
  const tavilyApiKeyEncrypted = asNullableString(record.tavilyApiKeyEncrypted) ?? null
  let tavilyApiKey: string | null = null
  if (tavilyApiKeyEncrypted !== null) {
    if (!deps.codec.isAvailable()) return null
    try {
      tavilyApiKey = deps.codec.decrypt(tavilyApiKeyEncrypted)
    } catch {
      return null
    }
  }

  const sidecarModel = asNullableString(record.sidecarModel) ?? null
  const sidecarBaseUrl = asNullableString(record.sidecarBaseUrl) ?? null
  const sidecarApiKeyEncrypted = asNullableString(record.sidecarApiKeyEncrypted) ?? null
  let sidecarApiKey: string | null = null
  if (sidecarApiKeyEncrypted !== null) {
    if (!deps.codec.isAvailable()) return null
    try {
      sidecarApiKey = deps.codec.decrypt(sidecarApiKeyEncrypted)
    } catch {
      return null
    }
  }

  const sidecarJevModel = asNullableString(record.sidecarJevModel) ?? null
  const sidecarJevBaseUrl = asNullableString(record.sidecarJevBaseUrl) ?? null
  const sidecarJevApiKeyEncrypted = asNullableString(record.sidecarJevApiKeyEncrypted) ?? null
  let sidecarJevApiKey: string | null = null
  if (sidecarJevApiKeyEncrypted !== null) {
    if (!deps.codec.isAvailable()) return null
    try {
      sidecarJevApiKey = deps.codec.decrypt(sidecarJevApiKeyEncrypted)
    } catch {
      return null
    }
  }

  return {
    model,
    baseUrl,
    apiKey,
    apiProtocol,
    typesafeApiKey,
    typesafeModel,
    typesafeBaseUrl,
    contextWindow,
    mineruApiUrl,
    mineruApiKey,
    bgeM3Path,
    bgeRerankerPath,
    proposerModel,
    reviewerModel,
    postgresHost,
    postgresPort,
    postgresUser,
    postgresPassword,
    postgresDatabase,
    vikingStoreRoot,
    tavilyApiKey,
    tavilyEndpoint,
    sidecarModel,
    sidecarBaseUrl,
    sidecarApiKey,
    sidecarJevModel,
    sidecarJevBaseUrl,
    sidecarJevApiKey
  }
}

/**
 * 写入设置。先加密再落盘：加密不可用时抛 ENCRYPTION_UNAVAILABLE 且不写文件——
 * 面板里明明填了 Key、文件里却没有，下次读出来就是「丢了一次输入」，
 * 不如整次保存失败，让用户看见原因。
 */
export function saveModelSettings(settings: ModelSettings, deps: ModelSettingsStoreDeps): void {
  const apiKey = normalize(settings.apiKey)
  let apiKeyEncrypted: string | null = null
  if (apiKey !== null) {
    if (!deps.codec.isAvailable()) {
      throw new SettingsSaveError(
        SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
        '系统密钥库不可用，API Key 无法加密保存'
      )
    }
    try {
      apiKeyEncrypted = deps.codec.encrypt(apiKey)
    } catch (e) {
      throw new SettingsSaveError(SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE, describe(e))
    }
  }

  const typesafeApiKey = normalize(settings.typesafeApiKey)
  let typesafeApiKeyEncrypted: string | null = null
  if (typesafeApiKey !== null) {
    if (!deps.codec.isAvailable()) {
      throw new SettingsSaveError(
        SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
        '系统密钥库不可用，TypeSafe API Key 无法加密保存'
      )
    }
    try {
      typesafeApiKeyEncrypted = deps.codec.encrypt(typesafeApiKey)
    } catch (e) {
      throw new SettingsSaveError(SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE, describe(e))
    }
  }

  const mineruApiKey = normalize(settings.mineruApiKey)
  let mineruApiKeyEncrypted: string | null = null
  if (mineruApiKey !== null) {
    if (!deps.codec.isAvailable()) {
      throw new SettingsSaveError(
        SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
        '系统密钥库不可用，MinerU API Key 无法加密保存'
      )
    }
    try {
      mineruApiKeyEncrypted = deps.codec.encrypt(mineruApiKey)
    } catch (e) {
      throw new SettingsSaveError(SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE, describe(e))
    }
  }

  const postgresPassword = normalize(settings.postgresPassword)
  let postgresPasswordEncrypted: string | null = null
  if (postgresPassword !== null) {
    if (!deps.codec.isAvailable()) {
      throw new SettingsSaveError(
        SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
        '系统密钥库不可用，PostgreSQL 密码无法加密保存'
      )
    }
    try {
      postgresPasswordEncrypted = deps.codec.encrypt(postgresPassword)
    } catch (e) {
      throw new SettingsSaveError(SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE, describe(e))
    }
  }

  const tavilyApiKey = normalize(settings.tavilyApiKey)
  let tavilyApiKeyEncrypted: string | null = null
  if (tavilyApiKey !== null) {
    if (!deps.codec.isAvailable()) {
      throw new SettingsSaveError(
        SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
        '系统密钥库不可用，Tavily API Key 无法加密保存'
      )
    }
    try {
      tavilyApiKeyEncrypted = deps.codec.encrypt(tavilyApiKey)
    } catch (e) {
      throw new SettingsSaveError(SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE, describe(e))
    }
  }

  const sidecarApiKey = normalize(settings.sidecarApiKey)
  let sidecarApiKeyEncrypted: string | null = null
  if (sidecarApiKey !== null) {
    if (!deps.codec.isAvailable()) {
      throw new SettingsSaveError(
        SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
        '系统密钥库不可用，Sidecar API Key 无法加密保存'
      )
    }
    try {
      sidecarApiKeyEncrypted = deps.codec.encrypt(sidecarApiKey)
    } catch (e) {
      throw new SettingsSaveError(SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE, describe(e))
    }
  }

  const sidecarJevApiKey = normalize(settings.sidecarJevApiKey)
  let sidecarJevApiKeyEncrypted: string | null = null
  if (sidecarJevApiKey !== null) {
    if (!deps.codec.isAvailable()) {
      throw new SettingsSaveError(
        SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE,
        '系统密钥库不可用，Sidecar Jev API Key 无法加密保存'
      )
    }
    try {
      sidecarJevApiKeyEncrypted = deps.codec.encrypt(sidecarJevApiKey)
    } catch (e) {
      throw new SettingsSaveError(SETTINGS_ERROR_CODE.ENCRYPTION_UNAVAILABLE, describe(e))
    }
  }

  const stored: StoredSettings = {
    version: SETTINGS_VERSION,
    model: normalize(settings.model),
    baseUrl: normalize(settings.baseUrl),
    apiKeyEncrypted,
    apiProtocol: settings.apiProtocol,
    typesafeApiKeyEncrypted,
    typesafeModel: normalize(settings.typesafeModel),
    typesafeBaseUrl: normalize(settings.typesafeBaseUrl),
    contextWindow:
      typeof settings.contextWindow === 'number' && settings.contextWindow > 0
        ? settings.contextWindow
        : null,
    mineruApiUrl: normalize(settings.mineruApiUrl),
    mineruApiKeyEncrypted,
    bgeM3Path: normalize(settings.bgeM3Path),
    bgeRerankerPath: normalize(settings.bgeRerankerPath),
    proposerModel: normalize(settings.proposerModel),
    reviewerModel: normalize(settings.reviewerModel),
    postgresHost: normalize(settings.postgresHost),
    postgresPort:
      typeof settings.postgresPort === 'number' && settings.postgresPort > 0
        ? settings.postgresPort
        : null,
    postgresUser: normalize(settings.postgresUser),
    postgresPasswordEncrypted,
    postgresDatabase: normalize(settings.postgresDatabase),
    vikingStoreRoot: normalize(settings.vikingStoreRoot),
    tavilyApiKeyEncrypted,
    tavilyEndpoint: normalize(settings.tavilyEndpoint),
    sidecarModel: normalize(settings.sidecarModel),
    sidecarBaseUrl: normalize(settings.sidecarBaseUrl),
    sidecarApiKeyEncrypted,
    sidecarJevModel: normalize(settings.sidecarJevModel),
    sidecarJevBaseUrl: normalize(settings.sidecarJevBaseUrl),
    sidecarJevApiKeyEncrypted
  }

  try {
    mkdirSync(dirname(deps.filePath), { recursive: true })
    writeFileSync(deps.filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  } catch (e) {
    throw new SettingsSaveError(SETTINGS_ERROR_CODE.WRITE_FAILED, describe(e))
  }
}

/**
 * 把已保存的模型设置合进子进程环境。spawn 的 env 是整份替换（见 python-supervisor.ts），
 * 所以返回值必须是完整的进程环境，而不是只有要覆盖的那几个键。
 *
 * 契约（输入输出）：
 * - inherited：Electron 进程的 process.env（不能改它）；settings：loadModelSettings 的结果，可为 null。
 * - settings 为 null → 原样拷贝继承环境（等于维持现状：全走 shell 里设的变量）。
 * - 继承环境里有非空 PERSONAL_AGENT_SCRIPT → OPENAI_* 与 TYPESAFE_* 一个都不注入。
 *   剧本模式是本次启动的显式指定（演示脚本、CI、E2E），压过持久化的设置。
 * - 其余情况逐字段覆盖：
 *   settings.model → OPENAI_MODEL、settings.baseUrl → OPENAI_BASE_URL、
 *   settings.apiKey → OPENAI_API_KEY、settings.apiProtocol → OPENAI_API_PROTOCOL、
 *   settings.typesafeApiKey → TYPESAFE_API_KEY、
 *   settings.typesafeModel → TYPESAFE_DEFAULT_MODEL、
 *   settings.typesafeBaseUrl → TYPESAFE_BASE_URL。
 *   settings 里为 null、空串或**纯空白**的字段不注入，保留继承值。
 *
 * 不变量：
 * - 返回新对象，改它不污染 inherited / process.env。
 * - 不注入空串 / 纯空白值。
 */
export function buildRuntimeEnv(
  inherited: NodeJS.ProcessEnv,
  settings: ModelSettings | null
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited }
  if (settings === null) return env

  if (
    typeof inherited.PERSONAL_AGENT_SCRIPT === 'string' &&
    inherited.PERSONAL_AGENT_SCRIPT.trim() !== ''
  ) {
    return env
  }

  if (settings.model?.trim()) {
    env.OPENAI_MODEL = settings.model
  }
  if (settings.baseUrl?.trim()) {
    env.OPENAI_BASE_URL = settings.baseUrl
  }
  if (settings.apiKey?.trim()) {
    env.OPENAI_API_KEY = settings.apiKey
  }
  if (settings.apiProtocol !== null) {
    env.OPENAI_API_PROTOCOL = settings.apiProtocol
  }

  if (settings.typesafeApiKey?.trim()) {
    env.TYPESAFE_API_KEY = settings.typesafeApiKey
  }
  if (settings.typesafeModel?.trim()) {
    env.TYPESAFE_DEFAULT_MODEL = settings.typesafeModel
  }
  if (settings.typesafeBaseUrl?.trim()) {
    env.TYPESAFE_BASE_URL = settings.typesafeBaseUrl
  }

  if (typeof settings.contextWindow === 'number' && settings.contextWindow > 0) {
    env[CONTEXT_WINDOW_ENV_KEY] = String(settings.contextWindow)
  }

  if (settings.mineruApiUrl?.trim()) {
    env[MINERU_API_URL_ENV_KEY] = settings.mineruApiUrl
  }
  if (settings.mineruApiKey?.trim()) {
    env[MINERU_API_KEY_ENV_KEY] = settings.mineruApiKey
  }

  if (settings.bgeM3Path?.trim()) {
    env[BGE_M3_PATH_ENV_KEY] = settings.bgeM3Path.trim()
  }
  if (settings.bgeRerankerPath?.trim()) {
    env[BGE_RERANKER_PATH_ENV_KEY] = settings.bgeRerankerPath.trim()
  }
  if (settings.proposerModel?.trim()) {
    env[PROPOSER_MODEL_ENV_KEY] = settings.proposerModel.trim()
  }
  if (settings.reviewerModel?.trim()) {
    env[REVIEWER_MODEL_ENV_KEY] = settings.reviewerModel.trim()
  }

  if (settings.postgresHost?.trim()) {
    env[POSTGRES_HOST_ENV_KEY] = settings.postgresHost.trim()
  }
  if (typeof settings.postgresPort === 'number' && settings.postgresPort > 0) {
    env[POSTGRES_PORT_ENV_KEY] = String(settings.postgresPort)
  }
  if (settings.postgresUser?.trim()) {
    env[POSTGRES_USER_ENV_KEY] = settings.postgresUser.trim()
  }
  if (settings.postgresPassword?.trim()) {
    env[POSTGRES_PASSWORD_ENV_KEY] = settings.postgresPassword.trim()
  }
  if (settings.postgresDatabase?.trim()) {
    env[POSTGRES_DB_ENV_KEY] = settings.postgresDatabase.trim()
  }

  if (settings.vikingStoreRoot?.trim()) {
    env[VIKING_ROOT_ENV_KEY] = settings.vikingStoreRoot.trim()
  }

  if (settings.tavilyApiKey?.trim()) {
    env[TAVILY_API_KEY_ENV_KEY] = settings.tavilyApiKey.trim()
  }
  if (settings.tavilyEndpoint?.trim()) {
    env[TAVILY_ENDPOINT_ENV_KEY] = settings.tavilyEndpoint.trim()
  }

  if (settings.sidecarModel?.trim()) {
    env[SIDECAR_MODEL_ENV_KEY] = settings.sidecarModel.trim()
  }
  if (settings.sidecarBaseUrl?.trim()) {
    env[SIDECAR_BASE_URL_ENV_KEY] = settings.sidecarBaseUrl.trim()
  }
  if (settings.sidecarApiKey?.trim()) {
    env[SIDECAR_API_KEY_ENV_KEY] = settings.sidecarApiKey.trim()
  }

  if (settings.sidecarJevModel?.trim()) {
    env[SIDECAR_JEV_MODEL_ENV_KEY] = settings.sidecarJevModel.trim()
  }
  if (settings.sidecarJevBaseUrl?.trim()) {
    env[SIDECAR_JEV_BASE_URL_ENV_KEY] = settings.sidecarJevBaseUrl.trim()
  }
  if (settings.sidecarJevApiKey?.trim()) {
    env[SIDECAR_JEV_API_KEY_ENV_KEY] = settings.sidecarJevApiKey.trim()
  }

  return env
}
