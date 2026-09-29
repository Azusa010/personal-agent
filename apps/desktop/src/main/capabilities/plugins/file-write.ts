import { FileWriteParams } from '@personal-agent/protocol'

import { writeFileAtomic } from '../file-write'
import { resolveWithinRootReal } from '../path-guard'
import { resolveRoot } from '../roots'
import type { CapabilityPlugin } from '../plugin'
import { invalid } from './helpers'

export const fileWritePlugin: CapabilityPlugin = {
  name: 'file_write',
  descriptor: {
    name: 'file_write',
    kind: 'WRITE',
    description: '在工作区内写入或完全覆盖文件，自动创建父级目录'
  },
  async bindArguments(args) {
    const parsed = FileWriteParams.safeParse(args)
    if (!parsed.success) return invalid('file_write', parsed.error.message)

    const root = resolveRoot('workspace')
    const guarded = await resolveWithinRootReal(root, parsed.data.path)
    if (!guarded.ok) {
      return { ok: false, code: guarded.code, reason: guarded.reason }
    }

    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: { path: guarded.path }
      }
    }
  },
  extractPermissionPaths(bound) {
    return { sourcePaths: [], targetPath: bound.paths['path'] ?? null }
  },
  idempotency: {
    isWrite: true,
    extractSideEffects(bound) {
      return { sourcePaths: [], targetPath: bound.paths['path'] ?? null }
    }
  },
  async execute(call) {
    const absPath = call.bound.paths['path']
    const content = String(call.bound.args['content'] ?? '')
    return writeFileAtomic(absPath, content)
  }
}
