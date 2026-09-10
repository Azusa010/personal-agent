import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { buildPdf } from './pdf-fixtures'
import { extractPdf } from './document-extract-pdf'

/**
 * 往上找 pnpm-workspace.yaml 定位仓库根。
 * 不写死 '../../../../../'：层级数被人挪动时会静默指错地方，
 * 而找特征文件失败会直接抛错，看得见。
 */
function repoRoot(): string {
  let dir = __dirname
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('找不到仓库根（pnpm-workspace.yaml）')
    dir = parent
  }
}

const FIXED_PDF = join(repoRoot(), 'tests', 'fixtures', 'pdfs', 'three-page-text.pdf')

/**
 * 冻结在文件里的期望值。
 * 改这里必须同时重新生成并重新提交上面那个 PDF，否则下面第三条测试会红。
 */
const EXPECTED_PAGES = [
  { pageNumber: 1, text: 'PersonalAgent fixture page one' },
  { pageNumber: 2, text: 'PersonalAgent fixture page two' },
  { pageNumber: 3, text: 'PersonalAgent fixture page three' }
]

describe('固定 PDF fixture（Exit 第 4 条）', () => {
  // 平时跳过。只在需要重新生成时设环境变量跑一次，然后把 PDF 提交进 git。
  // 留着不删，是为了记录「这个二进制是怎么来的」。
  it.runIf(process.env.WRITE_PDF_FIXTURES === '1')('落盘固定 PDF', () => {
    mkdirSync(dirname(FIXED_PDF), { recursive: true })
    writeFileSync(FIXED_PDF, Buffer.from(buildPdf(EXPECTED_PAGES.map((p) => p.text))))
  })

  it('fixture 已提交进仓库，不是每次现生成', () => {
    expect(existsSync(FIXED_PDF)).toBe(true)
  })

  it('从磁盘读固定 PDF，文本与页码逐字一致', async () => {
    const bytes = readFileSync(FIXED_PDF)
    // readFileSync 返回 Buffer；pdfjs 6.x 拒绝 Buffer，必须转纯 Uint8Array
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const result = await extractPdf(view)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toEqual(EXPECTED_PAGES)
  })
})
