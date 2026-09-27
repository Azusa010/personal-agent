import { ERROR_CODE } from '@personal-agent/protocol'

import { getCapabilityPlugin } from '../capabilities/plugins'

/** 契约校验 + 路径规范化之后的一次调用参数。 */
export interface BoundArgs {
  /** 过了契约校验的参数，原样字段名。 */
  args: Record<string, unknown>
  /** 键与参数名一致，值是规范化后的绝对路径。 */
  paths: Record<string, string>
}

export type BindResult =
  { ok: true; bound: BoundArgs } | { ok: false; code: string; reason: string }

/**
 * 将能力参数进行契约校验与路径规范化 (Path-Guard)。
 * 委托给自描述能力插件 (CapabilityPlugin.bindArguments)。
 */
export async function bindArguments(
  capability: string,
  args: Record<string, unknown>
): Promise<BindResult> {
  const plugin = getCapabilityPlugin(capability)
  if (plugin === undefined) {
    return { ok: false, code: ERROR_CODE.NOT_IMPLEMENTED, reason: `执行体未实现: ${capability}` }
  }
  return plugin.bindArguments(args)
}
