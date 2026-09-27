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

/**
 * 在指定绝对路径创建目录。
 * 遵循“执行-验证-反馈”闭环：完成 mkdir 后立即执行二次 stat 校验，确保文件系统落盘生效。
 */
export async function createDir(absPath: string): Promise<FilesystemCreateDirOutcome> {
  const stats = await safeStat(absPath)

  if (!stats) {
    try {
      await mkdir(absPath, { recursive: true })
      // 执行-验证-反馈闭环：核验新创建目录确实存在且为目录
      const verified = await safeStat(absPath)
      if (!verified || !verified.isDirectory()) {
        return fail(`目录创建后验证失败，未找到目标目录: ${absPath}`)
      }
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
