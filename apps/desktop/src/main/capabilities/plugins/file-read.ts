import { FileReadParams } from '@personal-agent/protocol'

import { readFileWithLineNumbers } from '../file-read'
import { resolveWithinRootReal } from '../path-guard'
import { resolveRoot } from '../roots'
import type { CapabilityPlugin } from '../plugin'
import { invalid } from './helpers'

export const fileReadPlugin: CapabilityPlugin = {
  name: 'file_read',
  descriptor: {
    name: 'file_read',
    kind: 'READ',
    description: '读取指定文件内容，支持按起始行号与结束行号分页读取，每行自带行号前缀'
  },
  async bindArguments(args) {
    const parsed = FileReadParams.safeParse(args)
    if (!parsed.success) return invalid('file_read', parsed.error.message)

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
  async execute(call) {
    const absPath = call.bound.paths['path']
    const startLine =
      typeof call.bound.args['startLine'] === 'number' ? call.bound.args['startLine'] : undefined
    const endLine =
      typeof call.bound.args['endLine'] === 'number' ? call.bound.args['endLine'] : undefined

    return readFileWithLineNumbers(absPath, { startLine, endLine })
  }
}
