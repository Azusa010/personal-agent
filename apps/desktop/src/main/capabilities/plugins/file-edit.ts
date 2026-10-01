import { readFile } from 'node:fs/promises'

import { FileEditParams } from '@personal-agent/protocol'

import { editFileStrict } from '../file-edit'
import { resolveWithinRootReal } from '../path-guard'
import { resolveRoot } from '../roots'
import type { CapabilityPlugin } from '../plugin'
import { auditExpectedValues, invalid } from './helpers'

export const fileEditPlugin: CapabilityPlugin = {
  name: 'file_edit',
  descriptor: {
    name: 'file_edit',
    kind: 'WRITE',
    description: '在现有文件中进行精准单块局部修改，Old String 必须在文件中全局唯一存在'
  },
  async bindArguments(args) {
    const parsed = FileEditParams.safeParse(args)
    if (!parsed.success) return invalid('file_edit', parsed.error.message)

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
    const oldString = String(call.bound.args['oldString'] ?? '')
    const newString = String(call.bound.args['newString'] ?? '')

    const expectedLineCount = call.bound.args['expected_file_line_count']
    const expectedOldStringLine = call.bound.args['expected_old_string_line']
    if (expectedLineCount !== undefined || expectedOldStringLine !== undefined) {
      const source = await readFile(absPath, 'utf8').catch(() => null)
      let actualLineCount: number | undefined
      let actualOldStringLine: number | undefined
      if (source !== null) {
        actualLineCount = source.split(/\r?\n/).length
        const idx = source.indexOf(oldString)
        if (idx !== -1) {
          actualOldStringLine = source.slice(0, idx).split(/\r?\n/).length
        }
      }
      auditExpectedValues(
        call.callId,
        call.capability.name,
        {
          expected_file_line_count: expectedLineCount,
          expected_old_string_line: expectedOldStringLine
        },
        {
          expected_file_line_count: actualLineCount,
          expected_old_string_line: actualOldStringLine
        }
      )
    }

    return editFileStrict(absPath, oldString, newString)
  }
}
