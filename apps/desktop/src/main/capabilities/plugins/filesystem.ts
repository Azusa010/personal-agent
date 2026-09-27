import {
  ERROR_CODE,
  FilesystemCreateDirParams,
  FilesystemListParams,
  FilesystemMoveParams
} from '@personal-agent/protocol'

import { createDir } from '../filesystem-create-dir'
import { listDirectory } from '../filesystem-list'
import { moveFile } from '../filesystem-move'
import { resolveWithinRootReal } from '../path-guard'
import { resolveRoot } from '../roots'
import type { RecoveryVerdict } from '../idempotency'
import type { ToolExecutionRecord } from '../../product-state/tool-execution-repository'
import type { CapabilityPlugin } from '../plugin'
import { describeError, fail, invalid, safeStat } from './helpers'

export const filesystemListPlugin: CapabilityPlugin = {
  name: 'filesystem_list',
  descriptor: {
    name: 'filesystem_list',
    kind: 'READ',
    description: '列出授权根目录下的条目'
  },
  async bindArguments(args) {
    const parsed = FilesystemListParams.safeParse(args)
    if (!parsed.success) return invalid('filesystem_list', parsed.error.message)
    return {
      ok: true,
      bound: {
        args: {
          rootId: parsed.data.rootId,
          ...(parsed.data.pattern ? { pattern: parsed.data.pattern } : {})
        },
        paths: {}
      }
    }
  },
  async execute(call) {
    const rootId = String(call.bound.args['rootId'])
    const pattern =
      typeof call.bound.args['pattern'] === 'string' ? call.bound.args['pattern'] : undefined
    try {
      const entries = await listDirectory(resolveRoot(rootId), { pattern })
      return { ok: true, entries }
    } catch (e) {
      return fail(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE, `授权根不可用 (${describeError(e)})`)
    }
  }
}

export const filesystemCreateDirPlugin: CapabilityPlugin = {
  name: 'filesystem_create_dir',
  descriptor: {
    name: 'filesystem_create_dir',
    kind: 'WRITE',
    description: '在授权根目录下创建子目录'
  },
  async bindArguments(args) {
    const parsed = FilesystemCreateDirParams.safeParse(args)
    if (!parsed.success) return invalid('filesystem_create_dir', parsed.error.message)

    const root = resolveRoot('downloads')
    const guarded = await resolveWithinRootReal(root, parsed.data.path)
    if (!guarded.ok) {
      return { ok: false, code: guarded.code, reason: guarded.reason }
    }
    return {
      ok: true,
      bound: { args: { path: parsed.data.path }, paths: { path: guarded.path } }
    }
  },
  extractPermissionPaths(bound) {
    return { sourcePaths: [], targetPath: bound.paths['path'] ?? null }
  },
  idempotency: {
    isWrite: true,
    extractSideEffects(bound) {
      return { sourcePaths: [], targetPath: bound.paths['path'] ?? null }
    },
    async resolveRecovery(record: ToolExecutionRecord): Promise<RecoveryVerdict> {
      if (record.targetPath === null) {
        return { kind: 'unknown', reason: '数据异常：targetPath 为 null' }
      }
      const targetStats = await safeStat(record.targetPath)
      if (targetStats && targetStats.isDirectory()) {
        return { kind: 'done' }
      }
      if (targetStats && !targetStats.isDirectory()) {
        return { kind: 'unknown', reason: '目标路径存在但不是目录' }
      }
      return { kind: 'not-done' }
    }
  },
  async execute(call) {
    const abs = call.bound.paths['path']
    try {
      return await createDir(abs)
    } catch (e) {
      return fail(ERROR_CODE.CREATE_DIR_FAILED, `创建目录失败 (${describeError(e)}): ${abs}`)
    }
  }
}

export const filesystemMovePlugin: CapabilityPlugin = {
  name: 'filesystem_move',
  descriptor: {
    name: 'filesystem_move',
    kind: 'WRITE',
    description: '在授权根目录内移动文件'
  },
  async bindArguments(args) {
    const parsed = FilesystemMoveParams.safeParse(args)
    if (!parsed.success) return invalid('filesystem_move', parsed.error.message)

    const root = resolveRoot('downloads')
    const source = await resolveWithinRootReal(root, parsed.data.source)
    if (!source.ok) {
      return {
        ok: false,
        code: source.code,
        reason: `${source.reason}（filesystem_move 的 source 参数）`
      }
    }
    const target = await resolveWithinRootReal(root, parsed.data.target)
    if (!target.ok) {
      return {
        ok: false,
        code: target.code,
        reason: `${target.reason}（filesystem_move 的 target 参数）`
      }
    }
    return {
      ok: true,
      bound: {
        args: { source: parsed.data.source, target: parsed.data.target },
        paths: { source: source.path, target: target.path }
      }
    }
  },
  extractPermissionPaths(bound) {
    return {
      sourcePaths: bound.paths['source'] !== undefined ? [bound.paths['source']] : [],
      targetPath: bound.paths['target'] ?? null
    }
  },
  idempotency: {
    isWrite: true,
    extractSideEffects(bound) {
      return {
        sourcePaths: bound.paths['source'] !== undefined ? [bound.paths['source']] : [],
        targetPath: bound.paths['target'] ?? null
      }
    },
    async resolveRecovery(record: ToolExecutionRecord): Promise<RecoveryVerdict> {
      if (record.sourcePaths.length === 0 || record.targetPath === null) {
        return { kind: 'unknown', reason: '数据异常：sourcePaths 为空或 targetPath 为 null' }
      }
      const sourceStats = await safeStat(record.sourcePaths[0])
      const targetStats = await safeStat(record.targetPath)
      if (!sourceStats && targetStats) {
        return { kind: 'done' }
      }
      if (!sourceStats && !targetStats) {
        return { kind: 'unknown', reason: '源路径和目标路径都不存在' }
      }
      if (sourceStats && targetStats) {
        return { kind: 'unknown', reason: '源路径和目标路径同时存在' }
      }
      return { kind: 'not-done' }
    }
  },
  async execute(call) {
    const source = call.bound.paths['source']
    const target = call.bound.paths['target']
    try {
      return await moveFile(source, target)
    } catch (e) {
      return fail(ERROR_CODE.MOVE_FAILED, `移动失败 (${describeError(e)}): ${source} -> ${target}`)
    }
  }
}
