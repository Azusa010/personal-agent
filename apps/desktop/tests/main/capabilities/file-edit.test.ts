import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODE } from '@personal-agent/protocol'

import {
  applyStrictReplacement,
  editFileStrict,
  fileEditPlugin
} from '../../../src/main/capabilities/plugins/file-edit'
import { toPosix } from '../../../src/main/capabilities/roots'

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

  it('成功替换并写回文件，且字节数与行数符合预期', async () => {
    const target = join(tempDir, 'sample.txt')
    await writeFile(target, 'line1\nline2\nline3', 'utf8')

    const outcome = await editFileStrict(target, 'line2', 'lineTwo')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.path).toBe(target)
      expect(outcome.replacements).toBe(1)
    }

    const written = await readFile(target, 'utf8')
    expect(written).toBe('line1\nlineTwo\nline3')
  })

  it('目标文件不存在时返回稳定错误码 FILE_UNREADABLE', async () => {
    const nonExistent = join(tempDir, 'not-found.txt')
    const outcome = await editFileStrict(nonExistent, 'foo', 'bar')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(ERROR_CODE.FILE_UNREADABLE)
    }
  })

  it('修改后代码出现语法错误时正常落盘且附带 diagnostics 警告', async () => {
    const target = join(tempDir, 'code.ts')
    await writeFile(target, 'const a: number = 1;\nconst b: number = 2;', 'utf8')

    const outcome = await editFileStrict(target, 'const a: number = 1;', 'const a: number = ;')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.diagnostics).toBeDefined()
      expect(outcome.diagnostics?.length).toBeGreaterThan(0)
    }
  })
})

describe('fileEditPlugin: 自描述插件闭环 (defineBinder + permissions + execute)', () => {
  let workspaceDir: string

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'pa-test-plugin-edit-'))
    vi.stubEnv('PERSONAL_AGENT_WORKSPACE_DIR', workspaceDir)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('插件基础元数据与幂等策略符合规范', () => {
    expect(fileEditPlugin.name).toBe('file_edit')
    expect(fileEditPlugin.descriptor.kind).toBe('WRITE')
    expect(fileEditPlugin.idempotency?.isWrite).toBe(true)
  })

  it('bindArguments：合法工作区相对路径规范化成功', async () => {
    const target = join(workspaceDir, 'edit-me.txt')
    await writeFile(target, 'hello world', 'utf8')

    const bindRes = await fileEditPlugin.bindArguments({
      path: 'edit-me.txt',
      oldString: 'hello',
      newString: 'world'
    })
    expect(bindRes.ok).toBe(true)
    if (bindRes.ok) {
      expect(toPosix(bindRes.bound.paths['path'])).toBe(toPosix(target))
      expect(bindRes.bound.args['oldString']).toBe('hello')
      expect(bindRes.bound.args['newString']).toBe('world')
    }
  })

  it('bindArguments：.. 指向工作区外也放行（写边界在批准卡片，不在路径前缀）', async () => {
    const bindRes = await fileEditPlugin.bindArguments({
      path: '../../escape.txt',
      oldString: 'a',
      newString: 'b'
    })
    expect(bindRes.ok).toBe(true)
  })

  it('bindArguments：Windows 保留设备名触发 PATH_DEVICE_NAME_FORBIDDEN 拦截', async () => {
    const bindRes = await fileEditPlugin.bindArguments({
      path: 'AUX.txt',
      oldString: 'a',
      newString: 'b'
    })
    expect(bindRes.ok).toBe(false)
    if (!bindRes.ok) {
      expect(bindRes.code).toBe('PATH_DEVICE_NAME_FORBIDDEN')
    }
  })

  it('bindArguments：缺少必填参数返回 INVALID_ARGUMENT', async () => {
    const bindRes = await fileEditPlugin.bindArguments({ path: 'a.txt' })
    expect(bindRes.ok).toBe(false)
    if (!bindRes.ok) {
      expect(bindRes.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }
  })

  it('execute：通过 ValidatedCall 成功完成单块局部替换', async () => {
    const target = join(workspaceDir, 'modify.txt')
    await writeFile(target, 'alpha\nbeta\ngamma', 'utf8')

    const call = {
      taskScope: {
        taskId: 't-1',
        conversationId: 'c-1',
        capabilities: ['file_edit']
      },
      capability: fileEditPlugin.descriptor,
      bound: {
        args: { path: 'modify.txt', oldString: 'beta', newString: 'delta' },
        paths: { path: target }
      }
    } as unknown as Parameters<typeof fileEditPlugin.execute>[0]

    const outcome = await fileEditPlugin.execute(call, {})
    expect(outcome.ok).toBe(true)
    const diskContent = await readFile(target, 'utf8')
    expect(diskContent).toBe('alpha\ndelta\ngamma')
  })
})
