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
  apiProtocol: z.enum(['responses', 'chat_completions']).nullable().optional()
})

const EMPTY_SETTINGS: ModelSettings = {
  model: null,
  baseUrl: null,
  apiKey: null,
  apiProtocol: null
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
      apiProtocol: settings?.apiProtocol ?? null
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
