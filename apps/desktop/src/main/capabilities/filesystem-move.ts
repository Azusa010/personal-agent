import { rename, stat } from 'node:fs/promises'
import { ERROR_CODE, type FilesystemMoveOutcome } from '@personal-agent/protocol'
import { Stats } from 'node:fs'

/** 失败返回的唯一出口。move 有三个业务码，所以 code 由调用点传入。 */
function fail(code: string, reason: string): FilesystemMoveOutcome {
  return { ok: false, code, reason }
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

export async function moveFile(source: string, target: string): Promise<FilesystemMoveOutcome> {
  const sourceStat = await safeStat(source)
  if (!sourceStat) {
    return fail(ERROR_CODE.MOVE_SOURCE_MISSING, `source missing: ${source}`)
  }
  const targetStat = await safeStat(target)
  if (targetStat) {
    return fail(ERROR_CODE.MOVE_TARGET_EXISTS, `target exists: ${target}`)
  }
  try {
    await rename(source, target)
    return { ok: true, source, target }
  } catch (e) {
    return fail(ERROR_CODE.MOVE_FAILED, `move failed: ${e}`)
  }
}
