import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODE } from '@personal-agent/protocol'

import {
  formatFileLines,
  readFileWithLineNumbers,
  fileReadPlugin
} from '../../../src/main/capabilities/plugins/file-read'
import { toPosix } from '../../../src/main/capabilities/roots'

describe('file-read: formatFileLines', () => {
  it('处理空字符串返回空内容与 0 行', () => {
    const res = formatFileLines('')
    expect(res.totalLines).toBe(0)
    expect(res.content).toBe('')
  })

  it('多行文本默认添加行号前缀并保留总行数', () => {
    const raw = 'line A\nline B\nline C'
    const res = formatFileLines(raw)
    expect(res.totalLines).toBe(3)
    expect(res.startLine).toBe(1)
    expect(res.endLine).toBe(3)
    expect(res.content).toBe('1: line A\n2: line B\n3: line C')
  })

  it('指定 [startLine, endLine] 截取指定行区间', () => {
    const raw = 'one\ntwo\nthree\nfour\nfive'
    const res = formatFileLines(raw, 2, 4)
    expect(res.totalLines).toBe(5)
    expect(res.startLine).toBe(2)
    expect(res.endLine).toBe(4)
    expect(res.content).toBe('2: two\n3: three\n4: four')
  })

  it('endLine 超出文件实际总行数时截断至总行数', () => {
    const raw = 'alpha\nbeta'
    const res = formatFileLines(raw, 1, 999)
    expect(res.totalLines).toBe(2)
    expect(res.startLine).toBe(1)
    expect(res.endLine).toBe(2)
    expect(res.content).toBe('1: alpha\n2: beta')
  })

  it('startLine > endLine 时返回空内容', () => {
    const raw = 'alpha\nbeta\ngamma'
    const res = formatFileLines(raw, 3, 2)
    expect(res.totalLines).toBe(3)
    expect(res.startLine).toBe(3)
    expect(res.endLine).toBe(2)
    expect(res.content).toBe('')
  })

  it('单个非空行正常输出行号 1', () => {
    const raw = 'hello world'
    const res = formatFileLines(raw)
    expect(res.totalLines).toBe(1)
    expect(res.startLine).toBe(1)
    expect(res.endLine).toBe(1)
    expect(res.content).toBe('1: hello world')
  })
})

describe('file-read: readFileWithLineNumbers', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-test-file-read-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('成功读取真实文件并返回带行号内容', async () => {
    const filePath = join(tempDir, 'demo.txt')
    await writeFile(filePath, 'foo\nbar\nbaz', 'utf8')

    const outcome = await readFileWithLineNumbers(filePath, { startLine: 1, endLine: 2 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.path).toBe(filePath)
      expect(outcome.totalLines).toBe(3)
      expect(outcome.content).toBe('1: foo\n2: bar')
    }
  })

  it('文件不存在时返回稳定错误码 FILE_UNREADABLE', async () => {
    const nonExistent = join(tempDir, 'not-found.txt')
    const outcome = await readFileWithLineNumbers(nonExistent)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(ERROR_CODE.FILE_UNREADABLE)
    }
  })

  it('目标路径是目录时返回稳定错误码 FILE_UNREADABLE', async () => {
    const subDir = join(tempDir, 'sub')
    await mkdir(subDir)
    const outcome = await readFileWithLineNumbers(subDir)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe(ERROR_CODE.FILE_UNREADABLE)
      expect(outcome.reason).toContain('目录')
    }
  })
})

describe('fileReadPlugin: 自描述插件闭环 (defineBinder + execute)', () => {
  let workspaceDir: string

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'pa-test-plugin-read-'))
    vi.stubEnv('PERSONAL_AGENT_WORKSPACE_DIR', workspaceDir)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('插件基础元数据符合规范', () => {
    expect(fileReadPlugin.name).toBe('file_read')
    expect(fileReadPlugin.descriptor.kind).toBe('READ')
    expect(fileReadPlugin.descriptor.name).toBe('file_read')
  })

  it('bindArguments：合法工作区相对路径规范化成功', async () => {
    const target = join(workspaceDir, 'hello.txt')
    await writeFile(target, 'line1\nline2', 'utf8')

    const bindRes = await fileReadPlugin.bindArguments({ path: 'hello.txt', startLine: 1, endLine: 1 })
    expect(bindRes.ok).toBe(true)
    if (bindRes.ok) {
      expect(toPosix(bindRes.bound.paths['path'])).toBe(toPosix(target))
      expect(bindRes.bound.args['startLine']).toBe(1)
      expect(bindRes.bound.args['endLine']).toBe(1)
    }
  })

  it('bindArguments：.. 指向工作区外也放行（读不设根界，卫生校验照走）', async () => {
    const bindRes = await fileReadPlugin.bindArguments({ path: '../../evil.txt' })
    expect(bindRes.ok).toBe(true)
  })

  it('bindArguments：Windows 保留设备名触发 PATH_DEVICE_NAME_FORBIDDEN 拦截', async () => {
    const bindRes = await fileReadPlugin.bindArguments({ path: 'CON.txt' })
    expect(bindRes.ok).toBe(false)
    if (!bindRes.ok) {
      expect(bindRes.code).toBe('PATH_DEVICE_NAME_FORBIDDEN')
    }
  })

  it('bindArguments：非法参数缺少必填 path 返回验证错误', async () => {
    const bindRes = await fileReadPlugin.bindArguments({})
    expect(bindRes.ok).toBe(false)
    if (!bindRes.ok) {
      expect(bindRes.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }
  })

  it('execute：通过 ValidatedCall 执行读取并正确透传切片选项', async () => {
    const target = join(workspaceDir, 'code.ts')
    await writeFile(target, 'const a = 1;\nconst b = 2;\nconst c = 3;', 'utf8')

    const call = {
      taskScope: {
        taskId: 't-1',
        conversationId: 'c-1',
        capabilities: ['file_read']
      },
      capability: fileReadPlugin.descriptor,
      bound: {
        args: { path: 'code.ts', startLine: 2, endLine: 3 },
        paths: { path: target }
      }
    } as unknown as Parameters<typeof fileReadPlugin.execute>[0]

    const outcome = await fileReadPlugin.execute(call, {})
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.content).toBe('2: const b = 2;\n3: const c = 3;')
      expect(outcome.totalLines).toBe(3)
      expect(outcome.startLine).toBe(2)
      expect(outcome.endLine).toBe(3)
    }
  })
})
