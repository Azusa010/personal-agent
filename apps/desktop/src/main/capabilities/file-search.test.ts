import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'
import { createExecutor } from './executor'
import { UI_ORIGIN, type PermissionGate } from '../policy/execution-policy'
import { RuleBasedToolRetriever } from './retriever'
import type { TaskScope } from './scope'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

let dir: string
const scope: TaskScope = {
  taskId: 't-search',
  capabilities: ['file_search']
}

function allowAllGate(): PermissionGate {
  return {
    request: async () => ({ approved: true }),
    verify: async () => ({ ok: true })
  }
}

function searchParams(args: Record<string, unknown>): HostExecuteToolParams {
  return {
    callId: 'call-1',
    capability: 'file_search',
    arguments: args
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-search-'))
  vi.stubEnv(ENV_NAME, dir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // Windows file lock
  }
})

describe('file_search 执行体 (跨平台文件与内容检索)', () => {
  it('按文件名通配符检索 (searchMode: filename)', async () => {
    await writeFile(join(dir, 'annual_report.pdf'), 'data')
    await writeFile(join(dir, 'quarterly_report.pdf'), 'data')
    await writeFile(join(dir, 'notes.txt'), 'data')

    const sub = join(dir, 'subfolder')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'deep_report.pdf'), 'data')

    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      searchParams({
        pattern: '*_report.pdf',
        searchMode: 'filename'
      })
    )

    expect(res['ok']).toBe(true)
    const matches = res['matches'] as Array<{ path: string }>
    expect(matches).toHaveLength(3)
    const paths = matches.map((m) => m.path).sort()
    expect(paths).toEqual([
      'annual_report.pdf',
      'quarterly_report.pdf',
      'subfolder/deep_report.pdf'
    ])
  })

  it('按纯文本内容行级检索 (searchMode: content_plain)', async () => {
    await writeFile(join(dir, 'log1.txt'), 'Line 1: OK\nLine 2: TARGET_KEYWORD found\nLine 3: End')
    await writeFile(join(dir, 'log2.txt'), 'Line 1: No match here')

    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      searchParams({
        pattern: 'TARGET_KEYWORD',
        searchMode: 'content_plain'
      })
    )

    expect(res['ok']).toBe(true)
    const matches = res['matches'] as Array<{
      path: string
      lineNumber: number
      lineContent: string
    }>
    expect(matches).toHaveLength(1)
    expect(matches[0]?.path).toBe('log1.txt')
    expect(matches[0]?.lineNumber).toBe(2)
    expect(matches[0]?.lineContent).toContain('TARGET_KEYWORD')
  })

  it('按正则表达式检索 (searchMode: content_regex)', async () => {
    await writeFile(
      join(dir, 'code.js'),
      'const a = 1;\nconst ERR_404 = "not found";\nconst b = 2;'
    )

    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      searchParams({
        pattern: 'ERR_\\d+',
        searchMode: 'content_regex'
      })
    )

    expect(res['ok']).toBe(true)
    const matches = res['matches'] as Array<{
      path: string
      lineNumber: number
      lineContent: string
    }>
    expect(matches).toHaveLength(1)
    expect(matches[0]?.lineNumber).toBe(2)
    expect(matches[0]?.lineContent).toContain('ERR_404')
  })

  it('超出 maxMatches 时标记 truncated: true', async () => {
    for (let i = 1; i <= 5; i++) {
      await writeFile(join(dir, `item_${i}.txt`), 'test')
    }

    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      searchParams({
        pattern: 'item_*.txt',
        maxMatches: 3
      })
    )

    expect(res['ok']).toBe(true)
    expect(res['truncated']).toBe(true)
    const matches = res['matches'] as Array<{ path: string }>
    expect(matches).toHaveLength(3)
  })

  it('无效正则表达式返回 INVALID_ARGUMENT', async () => {
    const executor = createExecutor(scope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: allowAllGate()
    })

    const res = await executor(
      searchParams({
        pattern: '[invalid(regex',
        searchMode: 'content_regex'
      })
    )

    expect(res['ok']).toBe(false)
    expect(res['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })
})
