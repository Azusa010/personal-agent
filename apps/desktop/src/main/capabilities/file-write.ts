import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ERROR_CODE, type FileWriteOutcome, type FileWriteResult } from '@personal-agent/protocol'

/**
 * 递归创建目标目录并安全写入文本内容。
 */
export async function writeFileAtomic(absPath: string, content: string): Promise<FileWriteOutcome> {
  try {
    const parentDir = dirname(absPath)
    await mkdir(parentDir, { recursive: true })
    await writeFile(absPath, content, 'utf8')
    const bytesWritten = Buffer.byteLength(content, 'utf8')

    const result: FileWriteResult = {
      ok: true,
      path: absPath,
      bytesWritten
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
