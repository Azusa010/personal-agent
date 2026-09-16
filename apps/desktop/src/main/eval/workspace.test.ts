import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { extractPdf } from '../capabilities/document-extract-pdf'
import { listPdfs } from '../capabilities/filesystem-list'
import type { EvalCase } from './case-manifest'
import { materializeCase, MTIME_STEP_MS } from './workspace'

/**
 * 工作区物化：清单 → 一次任务真能看见的 Downloads 目录。
 *
 * 这里走真文件系统与真 PDF 解析（不假端口）：物化出来的东西正是被测链路要读的
 * 输入，它错了后面全错，而错误形态是"PDF 读不出来"或"排序不对"这种运行期才
 * 暴露的问题。
 */

let dir = ''

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function makeCase(): EvalCase {
  return {
    id: 'multi-file',
    goal: '总结 b.pdf',
    pdfs: [
      { name: 'a.pdf', pages: ['alpha page one'] },
      { name: 'b.pdf', pages: ['beta page one', 'beta page two'] }
    ],
    extraFiles: [{ name: 'notes.txt', content: 'not a pdf' }],
    target: 'b.pdf',
    keyPoints: [{ id: 'kp', text: 'beta', keywords: ['beta'], pages: [2] }]
  }
}

describe('materializeCase', () => {
  it('生成的 PDF 真的能被解析，页数与页面文本与清单一致', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-eval-ws-'))
    const materialized = materializeCase(dir, makeCase())

    const extracted = await extractPdf(new Uint8Array(readFileSync(materialized.targetPath)))

    expect(extracted.ok).toBe(true)
    expect(extracted.ok && extracted.pages.map((p) => p.pageNumber)).toEqual([1, 2])
    expect(extracted.ok && extracted.pages[1]?.text).toContain('beta page two')
  })

  it('mtime 按清单顺序递增：最后一份最新（「最近改过的那份」因此有确定答案）', () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-eval-ws-'))
    const materialized = materializeCase(dir, makeCase())

    const times = materialized.files.map((f) => f.modifiedAtMs)
    // 时间戳是写死的基准 + 序号步长，不是 Date.now()：同一份清单每次跑都一样。
    expect(times[1] ?? 0).toBeGreaterThan(times[0] ?? 0)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(MTIME_STEP_MS)
  })

  it('落到授权根之后：filesystem.list 只列 PDF，且按 mtime 倒序（最新的在最前）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-eval-ws-'))
    materializeCase(dir, makeCase())

    const entries = await listPdfs(dir)

    expect(entries.map((e) => e.name)).toEqual(['b.pdf', 'a.pdf'])
    // 路径要正斜杠：模型拿到 absolutePath 之后直接原样回传给 extract_pdf。
    expect(entries.every((e) => !e.absolutePath.includes('\\'))).toBe(true)
  })
})
