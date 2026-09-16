import { describe, expect, it } from 'vitest'

import { MIN_EVAL_CASES, loadCaseManifest, parseCaseManifest, targetPdf } from './case-manifest'
import { evalCasesPath } from './paths'

/**
 * 用例清单的契约测试。
 *
 * 真清单（tests/evals/cases.json）必须过 schema —— 清单是评测的单一事实来源，
 * 它坏了（页码越界、文件名重复、目标文件写错）评测结果就整体失真，而且失真是
 * 静默的：case 会照跑，只是判据对不上。所以这里的重点是"坏清单必须被拒"。
 */

function makeCase(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    goal: '总结这份 PDF，带页码引用',
    pdfs: [{ name: `${id}.pdf`, pages: ['page one text', 'page two text'] }],
    extraFiles: [],
    target: null,
    // text 里必须能找到自己的某个 keyword：这是清单的不变量（scripted 模式的 fact
    // 正文就是这段 text），补足条数的 filler 也得守。
    keyPoints: [
      { id: 'kp', text: '第一页讲了 page one 的内容', keywords: ['page one'], pages: [1] }
    ],
    ...over
  }
}

/** 补足到 20 条合法 case：schema 里有"至少 20 条"的下限，单点用例也得先过这一关 */
function makeManifest(cases: unknown[]): unknown {
  const filled = [...cases]
  while (filled.length < MIN_EVAL_CASES) filled.push(makeCase(`filler-${filled.length}`))
  return { version: 1, cases: filled }
}

describe('真清单：tests/evals/cases.json', () => {
  const manifest = loadCaseManifest(evalCasesPath())

  it(`至少 ${MIN_EVAL_CASES} 条 case（REQ-011），id 不重复`, () => {
    expect(manifest.version).toBe(1)
    expect(manifest.cases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES)
    // id 重复会让报告里两条 case 重名，靠 schema 与 loader 两道拦。
    expect(new Set(manifest.cases.map((c) => c.id)).size).toBe(manifest.cases.length)
  })

  it('每条 case 的要点都落在目标 PDF 的页范围内', () => {
    for (const evalCase of manifest.cases) {
      const target = targetPdf(evalCase)
      const pageCount = target.pages.length
      for (const keyPoint of evalCase.keyPoints) {
        expect(
          Math.max(...keyPoint.pages),
          `${evalCase.id} 的要点 ${keyPoint.id}`
        ).toBeLessThanOrEqual(pageCount)
      }
    }
  })

  it('覆盖面：既有单文件也有多文件选择，且多文件都钉了 target', () => {
    const multi = manifest.cases.filter((c) => c.pdfs.length > 1)
    const single = manifest.cases.filter((c) => c.pdfs.length === 1)

    expect(single.length).toBeGreaterThan(0)
    expect(multi.length).toBeGreaterThan(0)
    for (const evalCase of multi) {
      expect(evalCase.target, `${evalCase.id} 多文件却没写 target`).not.toBeNull()
    }
  })

  it('清单里的页面文本与文件名都过得去 PDF 生成器（schema 已校验，这里留一条可读的失败信息）', () => {
    for (const evalCase of manifest.cases) {
      for (const pdf of evalCase.pdfs) {
        expect(pdf.name.endsWith('.pdf'), `${evalCase.id}: ${pdf.name}`).toBe(true)
        expect(pdf.pages.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('坏清单必须被拒', () => {
  function expectRejected(raw: unknown, hint = '坏清单必须被拒'): void {
    expect(() => parseCaseManifest(raw), hint).toThrow()
  }

  it('少于 20 条 case', () => {
    const cases = Array.from({ length: MIN_EVAL_CASES - 1 }, (_, i) => makeCase(`c-${i}`))
    expectRejected({ version: 1, cases }, 'REQ-011 要求至少 20 个预定义 Case')
  })

  it('case id 重复', () => {
    expectRejected(
      makeManifest([makeCase('dup'), makeCase('dup')]),
      '报告里两条 case 重名就分不清是哪一条坏了'
    )
  })

  it('目录里有多份 PDF 却没写 target', () => {
    expectRejected(
      makeManifest([
        makeCase('multi', {
          pdfs: [
            { name: 'a.pdf', pages: ['x'] },
            { name: 'b.pdf', pages: ['y'] }
          ],
          target: null
        })
      ]),
      '不写 target 就没法判定模型选对了哪一份'
    )
  })

  it('target 不在 pdfs 里', () => {
    expectRejected(makeManifest([makeCase('missing', { target: 'nope.pdf' })]))
  })

  it('要点引用了不存在的页码', () => {
    expectRejected(
      makeManifest([
        makeCase('bad-page', {
          keyPoints: [{ id: 'kp', text: 't', keywords: ['k'], pages: [3] }]
        })
      ]),
      '两页的 PDF 引用第 3 页：剧本会写出一条必然被 SummaryVerifier 拒掉的摘要'
    )
  })

  it('要点 id 重复', () => {
    expectRejected(
      makeManifest([
        makeCase('dup-kp', {
          keyPoints: [
            { id: 'kp', text: 't1', keywords: ['k1'], pages: [1] },
            { id: 'kp', text: 't2', keywords: ['k2'], pages: [2] }
          ]
        })
      ])
    )
  })

  it('页面文本带括号或反斜杠（会破坏 PDF 字符串字面量）', () => {
    expectRejected(
      makeManifest([
        makeCase('parens', { pdfs: [{ name: 'a.pdf', pages: ['total (net) 400 USD'] }] })
      ])
    )
    expectRejected(
      makeManifest([makeCase('backslash', { pdfs: [{ name: 'a.pdf', pages: ['path C:\\temp'] }] })])
    )
  })

  it('页面文本不是可打印 ASCII（latin1 会静默变问号）', () => {
    expectRejected(
      makeManifest([makeCase('cjk', { pdfs: [{ name: 'a.pdf', pages: ['第一页正文'] }] })])
    )
  })

  it('文件名带路径分隔符或不是 PDF', () => {
    expectRejected(
      makeManifest([makeCase('slash', { pdfs: [{ name: 'sub/a.pdf', pages: ['x'] }] })])
    )
    expectRejected(makeManifest([makeCase('txt', { pdfs: [{ name: 'notes.txt', pages: ['x'] }] })]))
  })

  it('版本号不是 1', () => {
    const manifest = makeManifest([]) as { version: number }
    expectRejected({ ...manifest, version: 2 }, '形状变了要显式改版本，不能悄悄换语义')
  })

  it('要点的关键词一个都不在自己的正文里', () => {
    expectRejected(
      makeManifest([
        makeCase('keyword-miss', {
          keyPoints: [
            { id: 'kp', text: '第三季度营收增长 12%', keywords: ['12 percent'], pages: [1] }
          ]
        })
      ]),
      'scripted 模式的 fact 正文就是 text：关键词不在里面等于自己造了一个永远漏掉的要点'
    )
  })

  it('关键词只要有一个命中就算过（多语言写法并列是允许的）', () => {
    const ok = makeManifest([
      makeCase('keyword-bilingual', {
        keyPoints: [
          {
            id: 'kp',
            text: '还剩重试风暴与日志无上限增长',
            keywords: ['retry storm', '重试风暴'],
            pages: [1]
          }
        ]
      })
    ])

    expect(() => parseCaseManifest(ok)).not.toThrow()
  })
})
