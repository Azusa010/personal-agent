import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SETTINGS_ERROR_CODE } from './error-code'

/** 用户级模型配置的内存形状。apiKey 是解密后的明文，只允许活在主进程
 *  字段可变：设置面板是「读出现状 → 改了哪几个字段 → 整体回写」，
 *  与 shared/domain.ts 的 TaskRecord / PermissionRecord 同一种写法。 */
export interface ModelSettings {
  model: string | null
  baseUrl: string | null
  apiKey: string | null
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

/** 落盘形状。apiKey 只存密文（base64），明文绝不进文件。 */
interface StoredSettings {
  version: number
  model: string | null
  baseUrl: string | null
  apiKeyEncrypted: string | null
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
function normalize(value: string | null): string | null {
  if (value === null) return null
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

  return { model, baseUrl, apiKey }
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

  const stored: StoredSettings = {
    version: SETTINGS_VERSION,
    model: normalize(settings.model),
    baseUrl: normalize(settings.baseUrl),
    apiKeyEncrypted
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
 * - 继承环境里有非空 PERSONAL_AGENT_SCRIPT → OPENAI_MODEL / OPENAI_API_KEY /
 *   OPENAI_BASE_URL 一个都不注入。剧本模式是本次启动的显式指定（演示脚本、CI、E2E），
 *   压过持久化的设置；反过来让设置静默顶掉剧本，演示会改打真模型——花钱、不确定、
 *   还从界面上看不出来。
 * - 其余情况逐字段覆盖：settings.model → OPENAI_MODEL、settings.baseUrl → OPENAI_BASE_URL、
 *   settings.apiKey → OPENAI_API_KEY。settings 里为 null、空串或**纯空白**的字段不注入，
 *   保留继承值（开发态 shell 里 export 的那套照旧可用）。
 *
 * 不变量：
 * - 返回新对象，改它不污染 inherited / process.env。
 * - 不注入空串 / 纯空白值的 OPENAI_*：Python 侧 os.environ.get 拿到 '' 是假值、拿到 '  ' 是真值，
 *   而存储层写盘前已把纯空白归一成 null（见 normalize）。这里对齐同一口径——手工改坏的文件
 *   （"model": "  "）不会变成一份真去调模型的垃圾配置。
 *
 * 验收：model-settings.test.ts 的 describe('buildRuntimeEnv')。
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

  return env
}
