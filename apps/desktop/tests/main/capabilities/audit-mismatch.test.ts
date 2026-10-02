import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCapabilityPlugin } from '../../../src/main/capabilities/plugins'
import { toPosix } from '../../../src/main/capabilities/roots'
import type { AuthorizedCall, CapabilityPluginContext } from '../../../src/main/capabilities/plugin'
import type { CapabilityId } from '@personal-agent/protocol'

describe('WRITE 插件 expected_* 审计 mismatch 行为验证 (TASK-C4)', () => {
  let tempDir: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tempDir = toPosix(await mkdtemp(join(tmpdir(), 'pa-audit-mismatch-')))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    warnSpy.mockRestore()
    await rm(tempDir, { recursive: true, force: true })
  })

  function makeCall(
    name: string,
    args: Record<string, unknown>,
    paths: Record<string, string> = {}
  ): AuthorizedCall {
    return {
      callId: 'call-mismatch-1',
      capability: { name: name as CapabilityId, kind: 'WRITE', description: 'test' },
      bound: { args, paths },
      taskId: 'task-mismatch-1'
    }
  }

  function getWarnLogs(): string {
    return warnSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
  }

  it('file_write: 预期文件不存在但实际已存在 -> 触发告警但不拦截正常写入', async () => {
    const target = join(tempDir, 'existing.txt')
    await writeFile(target, 'initial content', 'utf8')

    const call = makeCall(
      'file_write',
      { content: 'overwritten', expected_file_exists: false },
      { path: target }
    )

    const result = await getCapabilityPlugin('file_write')!.execute(call, {})
    expect(result['ok']).toBe(true)
    expect(result['diagnostics']).toEqual(
      expect.arrayContaining([expect.stringContaining('[AUDIT_MISMATCH] expected_file_exists')])
    )

    expect(warnSpy).toHaveBeenCalled()
    const warned = getWarnLogs()
    expect(warned).toContain('[AUDIT_MISMATCH]')
    expect(warned).toContain('field=expected_file_exists')
  })

  it('file_edit: 预期行数与行号不符 -> 触发告警且成功完成替换', async () => {
    const target = join(tempDir, 'edit.txt')
    await writeFile(target, 'line1\nline2\nline3\n', 'utf8')

    const call = makeCall(
      'file_edit',
      {
        oldString: 'line2',
        newString: 'line_two',
        expected_file_line_count: 99,
        expected_old_string_line: 1
      },
      { path: target }
    )

    const result = await getCapabilityPlugin('file_edit')!.execute(call, {})
    expect(result['ok']).toBe(true)
    expect(result['diagnostics']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[AUDIT_MISMATCH] expected_file_line_count'),
        expect.stringContaining('[AUDIT_MISMATCH] expected_old_string_line')
      ])
    )

    expect(warnSpy).toHaveBeenCalled()
    const warned = getWarnLogs()
    expect(warned).toContain('[AUDIT_MISMATCH]')
    expect(warned).toContain('expected_file_line_count')
    expect(warned).toContain('expected_old_string_line')
  })

  it('filesystem_create_dir: 预期父目录不存在但实际存在 -> 记录告警并成功建目录', async () => {
    const parentDir = join(tempDir, 'parent')
    await mkdir(parentDir)
    const newDir = join(parentDir, 'sub')

    const call = makeCall(
      'filesystem_create_dir',
      { path: newDir, expected_parent_exists: false },
      { path: newDir }
    )

    const result = await getCapabilityPlugin('filesystem_create_dir')!.execute(call, {})
    expect(result['ok']).toBe(true)

    const warned = getWarnLogs()
    expect(warned).toContain('[AUDIT_MISMATCH]')
    expect(warned).toContain('expected_parent_exists')
  })

  it('filesystem_move: 预期源文件不存在但实际存在 -> 记录告警且正常移动', async () => {
    const src = join(tempDir, 'src.txt')
    const dest = join(tempDir, 'dest.txt')
    await writeFile(src, 'content', 'utf8')

    const call = makeCall(
      'filesystem_move',
      { source: src, target: dest, expected_source_exists: false },
      { source: src, target: dest }
    )

    const result = await getCapabilityPlugin('filesystem_move')!.execute(call, {})
    expect(result['ok']).toBe(true)

    const warned = getWarnLogs()
    expect(warned).toContain('[AUDIT_MISMATCH]')
    expect(warned).toContain('expected_source_exists')
  })

  it('terminal_execute: 预期 cwd 不存在但实际存在 -> 记录告警且正常执行命令', async () => {
    const call = makeCall(
      'terminal_execute',
      { command: 'echo audit_test', expected_cwd_exists: false },
      { cwd: tempDir }
    )

    const result = await getCapabilityPlugin('terminal_execute')!.execute(call, {})
    expect(result['ok']).toBe(true)

    const warned = getWarnLogs()
    expect(warned).toContain('[AUDIT_MISMATCH]')
    expect(warned).toContain('expected_cwd_exists')
  })

  it('scheduler_create: 预期有重复但实际无重复 -> 记录告警且正常创建 reminder', async () => {
    const mockContext = {
      scheduler: {
        db: {
          transaction: (fn: () => unknown) => () => fn()
        },
        reminders: {
          findByTaskId: vi.fn().mockReturnValue(null),
          insert: vi.fn()
        },
        events: {
          append: vi.fn()
        },
        now: () => new Date().toISOString(),
        newId: () => 'reminder-test-1'
      }
    } as unknown as CapabilityPluginContext

    const futureIso = new Date(Date.now() + 60000).toISOString()
    const call = makeCall(
      'scheduler_create',
      { remindAt: futureIso, message: 'test msg', expected_no_duplicate: false },
      {}
    )

    const result = await getCapabilityPlugin('scheduler_create')!.execute(call, mockContext)
    expect(result['ok']).toBe(true)

    const warned = getWarnLogs()
    expect(warned).toContain('[AUDIT_MISMATCH]')
    expect(warned).toContain('expected_no_duplicate')
  })

  it('viking_write_l2: 预期文章已存在但实际为新文件 -> 记录告警且正常写入', async () => {
    const articlePath = join(tempDir, 'article.md')
    const call = makeCall(
      'viking_write_l2',
      { uri: 'viking://articles/article.md', content: 'test l2', expected_article_exists: true },
      { path: articlePath }
    )

    const result = await getCapabilityPlugin('viking_write_l2')!.execute(call, {})
    expect(result['ok']).toBe(true)

    const warned = getWarnLogs()
    expect(warned).toContain('[AUDIT_MISMATCH]')
    expect(warned).toContain('expected_article_exists')
  })
})
