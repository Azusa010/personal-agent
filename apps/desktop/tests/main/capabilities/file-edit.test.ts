import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ERROR_CODE } from '@personal-agent/protocol'

import { applyStrictReplacement, editFileStrict } from '../../../src/main/capabilities/file-edit'

describe('file-edit: applyStrictReplacement', () => {
  it('成功对全局唯一出现的 oldString 执行替换', () => {
    const original = 'const port = 3000;\nconsole.log(port);'
    const { newContent, replacements } = applyStrictReplacement(
      original,
      'const port = 3000;',
      'const port = 8080;'
    )
    expect(replacements).toBe(1)
    expect(newContent).toBe('const port = 8080;\nconsole.log(port);')
  })

  it('待替换文本未找到时抛出 FILE_EDIT_NOT_FOUND', () => {
    const original = 'function foo() { return 1; }'
    expect(() => applyStrictReplacement(original, 'bar()', 'baz()')).toThrowError(
      expect.objectContaining({ code: ERROR_CODE.FILE_EDIT_NOT_FOUND })
    )
  })

  it('待替换文本出现多次时抛出 FILE_EDIT_MULTIPLE_MATCHES', () => {
    const original = 'item\nitem\nitem'
    expect(() => applyStrictReplacement(original, 'item', 'product')).toThrowError(
      expect.objectContaining({ code: ERROR_CODE.FILE_EDIT_MULTIPLE_MATCHES })
    )
  })

  it('oldString 与 newString 完全相同时抛出 INVALID_ARGUMENT', () => {
    const original = 'const x = 1;'
    expect(() => applyStrictReplacement(original, 'const x = 1;', 'const x = 1;')).toThrowError(
      expect.objectContaining({ code: ERROR_CODE.INVALID_ARGUMENT })
    )
  })

  it('含正则特殊符号时按纯字面量精准匹配', () => {
    const original = 'const reg = /^[a-z]+$/;\nconst test = (val) => true;'
    const { newContent, replacements } = applyStrictReplacement(
      original,
      '/^[a-z]+$/;',
      '/^[0-9]+$/;'
    )
    expect(replacements).toBe(1)
    expect(newContent).toBe('const reg = /^[0-9]+$/;\nconst test = (val) => true;')
  })
})

describe('file-edit: editFileStrict', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-test-file-edit-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('真实文件编辑成功并写盘', async () => {
    const target = join(tempDir, 'app.ts')
    await writeFile(target, 'let mode = "dev";\nexport default mode;', 'utf8')

    const outcome = await editFileStrict(target, 'let mode = "dev";', 'let mode = "prod";')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.replacements).toBe(1)
      expect(outcome.path).toBe(target)
    }

    const updated = await readFile(target, 'utf8')
    expect(updated).toBe('let mode = "prod";\nexport default mode;')
  })

  it('文件不存在时返回稳定错误码 FILE_UNREADABLE', async () => {
    const nonExistent = join(tempDir, 'none.ts')
    const outcome = await editFileStrict(nonExistent, 'a', 'b')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(ERROR_CODE.FILE_UNREADABLE)
    }
  })

  it('未找到时返回结构化失败 FILE_EDIT_NOT_FOUND', async () => {
    const target = join(tempDir, 'sample.txt')
    await writeFile(target, 'hello world', 'utf8')

    const outcome = await editFileStrict(target, 'missing', 'new')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(ERROR_CODE.FILE_EDIT_NOT_FOUND)
    }
  })
})
