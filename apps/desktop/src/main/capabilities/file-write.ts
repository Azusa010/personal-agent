import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ERROR_CODE, type FileWriteOutcome, type FileWriteResult } from '@personal-agent/protocol'
import { runDiagnosticProbe } from './diagnostic-probe'
import { resolveRoot } from './roots'

/**
 * 递归创建目标目录并安全写入文本内容。
 * 写盘成功后触发即时诊断探针（Tier 0 / Tier 1），附带语法与质量告警。
 */
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
