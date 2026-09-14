import { mkdir, stat } from 'node:fs/promises'
import { Stats } from 'node:fs'
import { ERROR_CODE, type FilesystemCreateDirOutcome } from '@personal-agent/protocol'

/** 失败返回的唯一出口：码固定 CREATE_DIR_FAILED，只有 reason 变。
 *  留给你填的分支里，凡是失败都走它，别自己拼 { ok:false, ... }。
 */
function fail(reason: string): FilesystemCreateDirOutcome {
  return { ok: false, code: ERROR_CODE.CREATE_DIR_FAILED, reason }
}

async function safeStat(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export async function createDir(absPath: string): Promise<FilesystemCreateDirOutcome> {
  const stats = await safeStat(absPath)

  if (!stats) {
    try {
      await mkdir(absPath, { recursive: true })
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    return { ok: true, path: absPath, created: true }
  }
  if (stats.isDirectory()) {
    return { ok: true, path: absPath, created: false }
  }
  return fail(`${absPath} exists but not a directory`)
}
