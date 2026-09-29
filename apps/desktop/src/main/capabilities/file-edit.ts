import { readFile, writeFile } from 'node:fs/promises'
import { ERROR_CODE, type FileEditOutcome, type FileEditResult } from '@personal-agent/protocol'

export class FileEditError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'FileEditError'
  }
}

/**
 * 严格唯一匹配 Old String -> New String 替换算法。
 * Claude Code 标杆：若出现 0 次或大于 1 次均抛出结构化错误。
 */
export function applyStrictReplacement(
  source: string,
  oldString: string,
  newString: string
): { newContent: string; replacements: number } {
  if (oldString === newString) {
    throw new FileEditError(
      ERROR_CODE.INVALID_ARGUMENT,
      'oldString 与 newString 相同，未作任何修改'
    )
  }

  const count = source.split(oldString).length - 1

  if (count === 0) {
    throw new FileEditError(ERROR_CODE.FILE_EDIT_NOT_FOUND, '待替换文本未在目标文件中找到')
  }

  if (count > 1) {
    throw new FileEditError(
      ERROR_CODE.FILE_EDIT_MULTIPLE_MATCHES,
      `待替换文本在目标文件中出现 ${count} 次，匹配不具有唯一性`
    )
  }

  const newContent = source.replace(oldString, newString)
  return { newContent, replacements: 1 }
}

/**
 * 编辑文件底层执行体：读取现有文件、严格唯一替换并写回。
 */
export async function editFileStrict(
  absPath: string,
  oldString: string,
  newString: string
): Promise<FileEditOutcome> {
  let source: string
  try {
    source = await readFile(absPath, 'utf8')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      code: ERROR_CODE.FILE_UNREADABLE,
      reason: `无法读取待编辑文件 (${msg}): ${absPath}`
    }
  }

  try {
    const { newContent, replacements } = applyStrictReplacement(source, oldString, newString)
    await writeFile(absPath, newContent, 'utf8')

    const result: FileEditResult = {
      ok: true,
      path: absPath,
      replacements
    }
    return result
  } catch (e) {
    if (e instanceof FileEditError) {
      return {
        ok: false,
        code: e.code,
        reason: e.message
      }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      code: ERROR_CODE.FILE_EDIT_FAILED,
      reason: `文件编辑失败 (${msg}): ${absPath}`
    }
  }
}
