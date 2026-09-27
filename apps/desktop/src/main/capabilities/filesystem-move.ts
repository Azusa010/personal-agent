import { copyFile, rename, stat, unlink } from 'node:fs/promises'
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

/**
 * 在授权根目录内移动文件。
 * - 负向约束：目标已存在时绝不静默覆盖，抛出 MOVE_TARGET_EXISTS；
 * - 健壮性保障：捕获跨卷 EXDEV 异常并无缝 fallback 到 copy + unlink；
 * - 执行-验证-反馈闭环：移动后校验目标存在且字节大小一致，确保副作用彻底发生。
 */
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
  } catch (e: unknown) {
    const errno = e as NodeJS.ErrnoException
    if (errno.code === 'EXDEV') {
      try {
        await copyFile(source, target)
        await unlink(source)
      } catch (copyErr) {
        return fail(ERROR_CODE.MOVE_FAILED, `跨卷复制移动失败: ${copyErr}`)
      }
    } else {
      return fail(ERROR_CODE.MOVE_FAILED, `move failed: ${e}`)
    }
  }

  // 执行-验证-反馈闭环：核验目标存在且大小与原文件一致，源文件已不在
  const verifiedTarget = await safeStat(target)
  const verifiedSource = await safeStat(source)
  if (!verifiedTarget || verifiedTarget.size !== sourceStat.size || verifiedSource !== undefined) {
    return fail(ERROR_CODE.MOVE_FAILED, `文件移动后状态校验异常: 目标未正确就位或源文件残留`)
  }

  return { ok: true, source, target }
}
