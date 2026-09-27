import {
  ERROR_CODE,
  VikingReadL0Params,
  VikingReadL1Params,
  VikingReadL2Params,
  VikingWriteL2Params
} from '@personal-agent/protocol'

import { resolveVikingUriWithinRootReal } from '../path-guard'
import {
  readVikingL0ByTarget,
  readVikingL1ByTarget,
  readVikingL2ByTarget,
  resolveVikingStoreRoot,
  writeVikingL2ByTarget
} from '../../viking/viking-store'
import type { BindResult } from '../../policy/argument-binders'
import type { CapabilityPlugin } from '../plugin'
import {
  describeError,
  fail,
  invalid,
  wrapExternalSource,
  VIKING_ISOLATION_HEADER,
  VIKING_ISOLATION_FOOTER
} from './helpers'

async function bindVikingUri(
  capabilityName: string,
  uri: string,
  extraArgs: Record<string, unknown>
): Promise<BindResult> {
  try {
    const root = resolveVikingStoreRoot()
    const guardedPath = await resolveVikingUriWithinRootReal(uri, root)
    return {
      ok: true as const,
      bound: {
        args: extraArgs,
        paths: { path: guardedPath }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code =
      msg.includes('VIKING_SANDBOX_ESCAPE') ||
      msg.includes('PATH_OUT_OF_ROOT') ||
      msg.includes('PATH_ESCAPES_ROOT_VIA_LINK')
        ? ERROR_CODE.PATH_OUT_OF_ROOT
        : ERROR_CODE.INVALID_ARGUMENT
    return {
      ok: false as const,
      code,
      reason: `${capabilityName} URI 校验失败: ${msg}`
    }
  }
}

export const vikingReadL0Plugin: CapabilityPlugin = {
  name: 'viking_read_l0',
  descriptor: {
    name: 'viking_read_l0',
    kind: 'READ',
    description: '读取 Viking 维基条目的 L0 摘要 (.abstract)'
  },
  async bindArguments(args) {
    const parsed = VikingReadL0Params.safeParse(args)
    if (!parsed.success) return invalid('viking_read_l0', parsed.error.message)
    return bindVikingUri('viking_read_l0', parsed.data.uri, parsed.data as Record<string, unknown>)
  },
  async execute(call) {
    try {
      const targetPath = call.bound.paths['path']
      const uri = String(call.bound.args['uri'])
      const { abstractText, isValid } = await readVikingL0ByTarget(targetPath, uri)
      const wrappedAbstract = wrapExternalSource(
        abstractText,
        VIKING_ISOLATION_HEADER,
        VIKING_ISOLATION_FOOTER
      )
      return { ok: true, uri, abstractText: wrappedAbstract, isValid }
    } catch (e) {
      return fail(ERROR_CODE.HOST_HANDLER_FAILED, `viking_read_l0 读取失败: ${describeError(e)}`)
    }
  }
}

export const vikingReadL1Plugin: CapabilityPlugin = {
  name: 'viking_read_l1',
  descriptor: {
    name: 'viking_read_l1',
    kind: 'READ',
    description: '读取 Viking 维基目录的 L1 概览 (.overview)'
  },
  async bindArguments(args) {
    const parsed = VikingReadL1Params.safeParse(args)
    if (!parsed.success) return invalid('viking_read_l1', parsed.error.message)
    return bindVikingUri('viking_read_l1', parsed.data.uri, parsed.data as Record<string, unknown>)
  },
  async execute(call) {
    try {
      const targetPath = call.bound.paths['path']
      const uri = String(call.bound.args['uri'])
      const overviewText = await readVikingL1ByTarget(targetPath, uri)
      const wrappedOverview = wrapExternalSource(
        overviewText,
        VIKING_ISOLATION_HEADER,
        VIKING_ISOLATION_FOOTER
      )
      return { ok: true, uri, overviewText: wrappedOverview }
    } catch (e) {
      return fail(ERROR_CODE.HOST_HANDLER_FAILED, `viking_read_l1 读取失败: ${describeError(e)}`)
    }
  }
}

export const vikingReadL2Plugin: CapabilityPlugin = {
  name: 'viking_read_l2',
  descriptor: {
    name: 'viking_read_l2',
    kind: 'READ',
    description: '读取 Viking 维基条目的 L2 全文 (*.md)'
  },
  async bindArguments(args) {
    const parsed = VikingReadL2Params.safeParse(args)
    if (!parsed.success) return invalid('viking_read_l2', parsed.error.message)
    return bindVikingUri('viking_read_l2', parsed.data.uri, parsed.data as Record<string, unknown>)
  },
  async execute(call) {
    try {
      const targetPath = call.bound.paths['path']
      const uri = String(call.bound.args['uri'])
      const content = await readVikingL2ByTarget(targetPath, uri)
      const wrappedContent = wrapExternalSource(
        content,
        VIKING_ISOLATION_HEADER,
        VIKING_ISOLATION_FOOTER
      )
      return { ok: true, uri, content: wrappedContent }
    } catch (e) {
      return fail(ERROR_CODE.HOST_HANDLER_FAILED, `viking_read_l2 读取失败: ${describeError(e)}`)
    }
  }
}

export const vikingWriteL2Plugin: CapabilityPlugin = {
  name: 'viking_write_l2',
  descriptor: {
    name: 'viking_write_l2',
    kind: 'WRITE',
    description: '写入或更新 Viking 维基条目的 L2 全文 (*.md)'
  },
  async bindArguments(args) {
    const parsed = VikingWriteL2Params.safeParse(args)
    if (!parsed.success) return invalid('viking_write_l2', parsed.error.message)
    return bindVikingUri('viking_write_l2', parsed.data.uri, parsed.data as Record<string, unknown>)
  },
  extractPermissionPaths(bound) {
    return { sourcePaths: [], targetPath: bound.paths['path'] ?? null }
  },
  async execute(call) {
    try {
      const targetPath = call.bound.paths['path']
      const uri = String(call.bound.args['uri'])
      const content = String(call.bound.args['content'])
      const res = await writeVikingL2ByTarget(targetPath, content)
      return { ok: true, uri, bytesWritten: res.bytesWritten, path: res.path }
    } catch (e) {
      return fail(ERROR_CODE.HOST_HANDLER_FAILED, `viking_write_l2 写入失败: ${describeError(e)}`)
    }
  }
}
