import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODE } from '@personal-agent/protocol'

import { writeFileAtomic, fileWritePlugin } from '../../../src/main/capabilities/plugins/file-write'
import { toPosix } from '../../../src/main/capabilities/roots'

describe('file-write: writeFileAtomic', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-test-file-write-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('成功写入文本文件并返回精确字节数', async () => {
    const target = join(tempDir, 'output.txt')
    const content = 'hello world'
    const outcome = await writeFileAtomic(target, content)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.path).toBe(target)
      expect(outcome.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'))
    }

    const written = await readFile(target, 'utf8')
    expect(written).toBe(content)
  })

  it('自动创建深层嵌套的不存在父目录', async () => {
    const deepTarget = join(tempDir, 'a', 'b', 'c', 'nested.ts')
    const content = 'export const x = 42;'
    const outcome = await writeFileAtomic(deepTarget, content)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'))
    }

    const written = await readFile(deepTarget, 'utf8')
    expect(written).toBe(content)
  })

  it('完全覆盖已有文件内容', async () => {
    const target = join(tempDir, 'overwrite.txt')
    await writeFileAtomic(target, 'old content')
    const outcome = await writeFileAtomic(target, 'new content')

    expect(outcome.ok).toBe(true)
    const written = await readFile(target, 'utf8')
    expect(written).toBe('new content')
  })

  it('写入存在语法错误的代码时正常落盘且附带 diagnostics 警告', async () => {
    const target = join(tempDir, 'broken.ts')
    const brokenCode = 'const x: number = ;\nconst y = 1;'
    const outcome = await writeFileAtomic(target, brokenCode)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.diagnostics).toBeDefined()
      expect(outcome.diagnostics?.length).toBeGreaterThan(0)
    }

    const written = await readFile(target, 'utf8')
    expect(written).toBe(brokenCode)
  })
})

describe('fileWritePlugin: 自描述插件闭环 (defineBinder + permissions + execute)', () => {
  let workspaceDir: string

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'pa-test-plugin-write-'))
    vi.stubEnv('PERSONAL_AGENT_WORKSPACE_DIR', workspaceDir)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('插件基础元数据与幂等策略符合规范', () => {
    expect(fileWritePlugin.name).toBe('file_write')
    expect(fileWritePlugin.descriptor.kind).toBe('WRITE')
    expect(fileWritePlugin.idempotency?.isWrite).toBe(true)
  })

  it('bindArguments：合法工作区相对路径规范化成功', async () => {
    const bindRes = await fileWritePlugin.bindArguments({ path: 'new-file.txt', content: 'test content' })
    expect(bindRes.ok).toBe(true)
    if (bindRes.ok) {
      const expected = join(workspaceDir, 'new-file.txt')
      expect(toPosix(bindRes.bound.paths['path'])).toBe(toPosix(expected))
      expect(bindRes.bound.args['content']).toBe('test content')
    }
  })

  it('bindArguments：.. 指向工作区外也放行（写边界在批准卡片，不在路径前缀）', async () => {
    const bindRes = await fileWritePlugin.bindArguments({ path: '../../evil.txt', content: 'hack' })
    expect(bindRes.ok).toBe(true)
  })

  it('bindArguments：Windows 保留设备名触发 PATH_DEVICE_NAME_FORBIDDEN 拦截', async () => {
    const bindRes = await fileWritePlugin.bindArguments({ path: 'NUL', content: 'empty' })
    expect(bindRes.ok).toBe(false)
    if (!bindRes.ok) {
      expect(bindRes.code).toBe('PATH_DEVICE_NAME_FORBIDDEN')
    }
  })

  it('bindArguments：缺少必填参数返回 INVALID_ARGUMENT', async () => {
    const bindRes = await fileWritePlugin.bindArguments({})
    expect(bindRes.ok).toBe(false)
    if (!bindRes.ok) {
      expect(bindRes.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }
  })

  it('execute：通过 ValidatedCall 成功写入文件', async () => {
    const target = join(workspaceDir, 'created.txt')
    const call = {
      taskScope: {
        taskId: 't-1',
        conversationId: 'c-1',
        capabilities: ['file_write']
      },
      capability: fileWritePlugin.descriptor,
      bound: {
        args: { path: 'created.txt', content: 'plugin wrote this' },
        paths: { path: target }
      }
    } as unknown as Parameters<typeof fileWritePlugin.execute>[0]

    const outcome = await fileWritePlugin.execute(call, {})
    expect(outcome.ok).toBe(true)
    const diskContent = await readFile(target, 'utf8')
    expect(diskContent).toBe('plugin wrote this')
  })
})
