import {
  ERROR_CODE,
  FileWriteParams,
  type FileWriteOutcome,
  type FileWriteResult
} from '@personal-agent/protocol'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { resolveRoot } from '../roots'
import type { CapabilityPlugin } from '../plugin'
import { auditExpectedValues, safeStat } from './helpers'
import { runDiagnosticProbe } from '../diagnostic-probe'
import { defineBinder } from '../binder'

export async function writeFileAtomic(absPath: string, content: string): Promise<FileWriteOutcome> {
  try {
    const parentDir = dirname(absPath)
    await mkdir(parentDir, { recursive: true })
    await writeFile(absPath, content, 'utf8')
    const bytesWritten = Buffer.byteLength(content, 'utf8')

    let workspaceRoot: string
    try {
      workspaceRoot = resolveRoot('workspace')
    } catch {
      workspaceRoot = parentDir
    }

    const probe = await runDiagnosticProbe(workspaceRoot, absPath, content).catch(() => ({
      diagnostics: []
    }))

    const result: FileWriteResult = {
      ok: true,
      path: absPath,
      bytesWritten,
      ...(probe.diagnostics.length > 0 ? { diagnostics: probe.diagnostics } : {})
    }
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      code: ERROR_CODE.FILE_WRITE_FAILED,
      reason: `写入文件失败 (${msg}): ${absPath}`
    }
  }
}

export const fileWritePlugin: CapabilityPlugin = {
  name: 'file_write',
  descriptor: {
    name: 'file_write',
    kind: 'WRITE',
    description: '在工作区内写入或完全覆盖文件，自动创建父级目录'
  },
  bindArguments: defineBinder('file_write', FileWriteParams, [
    { field: 'path', root: 'workspace' }
  ]),
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
    const fileStat = await safeStat(absPath)
    const audit = auditExpectedValues(
      call.callId,
      call.capability.name,
      { expected_file_exists: call.bound.args['expected_file_exists'] },
      { expected_file_exists: fileStat !== undefined }
    )
    const result = await writeFileAtomic(absPath, content)
    if (audit.hasMismatch && result.ok) {
      const extraDiags = audit.mismatches.map(
        (m) => `[AUDIT_MISMATCH] ${m.field}: expected=${m.expected}, actual=${m.actual}`
      )
      const existing = (result as { diagnostics?: string[] }).diagnostics ?? []
      return {
        ...result,
        diagnostics: [...existing, ...extraDiags]
      }
    }
    return result
  }
}
