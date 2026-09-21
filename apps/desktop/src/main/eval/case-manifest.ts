import { readFileSync } from 'node:fs'

import { z } from 'zod'

/**
 * Live Eval 的用例清单。
 *
 * 一条 case = 「一份（或几份）PDF + 一句目标 + 想要的结果长什么样」。清单是
 * 唯一事实来源：scripted 模式据此合成确定性剧本（CI 跑），live 模式把目标交给
 * 真模型（人手跑），两种模式判的是同一套期望。
 *
 * 页面文本为什么限定可打印 ASCII：写 PDF 走 main/capabilities/pdf-fixtures.ts
 * 的 buildPdf，它把每页文本按 PDF 字符串字面量写进内容流。括号与反斜杠会提前
 * 结束字面量（生成出结构坏掉的 PDF），非 ASCII 在 latin1 编码下静默变问号。
 * 判定侧的关键词仍然可以是中文——那是对摘要正文匹配的，不进 PDF。
 */

/** 至少 20 个预定义 Case。低于这个数，清单本身就是不合规的 */
export const MIN_EVAL_CASES = 20

const PDF_SAFE_TEXT = /^[\x20-\x7e]*$/
const PDF_UNSAFE_CHARS = /[()\\]/

const PageTextInput = z
  .string()
  .regex(PDF_SAFE_TEXT, '页面文本只能是可打印 ASCII（buildPdf 用 latin1 写内容流）')
  .refine(
    (text) => !PDF_UNSAFE_CHARS.test(text),
    '页面文本不能含括号或反斜杠（会破坏 PDF 字符串字面量）'
  )

const FileName = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/, '文件名里不能带路径分隔符')

export const EvalCasePdf = z.object({
  name: FileName.refine((n) => n.toLowerCase().endsWith('.pdf'), 'PDF 文件名要以 .pdf 结尾'),
  /** 逐页文本。**顺序即页码**（第 1 项是第 1 页），页数就是这份 PDF 的页数 */
  pages: z.array(PageTextInput).min(1)
})

/**
 * 一个「应该出现在摘要里」的要点。
 *
 * - keywords：命中判据。facts 的正文里出现**任意一个**就算命中（大小写不敏感），
 *   所以要么挑模型无论用中文还是英文作答都会保留的字面量（数字、日期、专名），
 *   要么把两种写法都列上（`["重试风暴", "retry storm"]`）。
 * - text：scripted 模式下剧本里那一条 fact 的正文。
 * - pages：这条要点所在的页。必须落在目标 PDF 的页集合内。
 *
 * `text` 必须能被自己的某个 keyword 命中：scripted 模式的 fact 正文就是这段 text，
 * 关键词不在里面等于自己造了一个永远漏掉的要点——它不会报错，只会让召回率悄悄
 * 掉一截（live 模式的真模型也可能因此判成漏，而其实答对了）。所以这条不变量
 * 在加载时就拦。
 */
export const EvalKeyPoint = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    keywords: z.array(z.string().min(1)).min(1),
    pages: z.array(z.number().int().positive()).min(1)
  })
  .refine(
    (keyPoint) => {
      const text = keyPoint.text.toLowerCase()
      return keyPoint.keywords.some((keyword) => text.includes(keyword.toLowerCase()))
    },
    {
      message:
        '至少有一个 keyword 要能在自己的 text 里找到（scripted 模式下 fact 正文就是这段 text）'
    }
  )

export const EvalExtraFile = z.object({
  name: FileName,
  content: z.string()
})

export const EvalCase = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'id 用小写字母数字与短横线'),
    goal: z.string().min(1),
    /**
     * 落进这次任务的授权根。顺序有含义：按清单顺序写入，每份比前一份晚 1 分钟
     * 落盘——「最近改过的那份」这类目标因此是确定的，最后一份最新。
     */
    pdfs: z.array(EvalCasePdf).min(1),
    /** 混在目录里的非 PDF 文件：filesystem_list 只列 PDF，这些是选择干扰项 */
    extraFiles: z.array(EvalExtraFile).default([]),
    /** 期望被提取的那份 PDF。null 只在目录里只有一份 PDF 时合法 */
    target: z.string().min(1).nullable().default(null),
    keyPoints: z.array(EvalKeyPoint).min(1)
  })
  .superRefine((evalCase, ctx) => {
    const names = [...evalCase.pdfs.map((p) => p.name), ...evalCase.extraFiles.map((f) => f.name)]
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', message: `同一目录里文件名重复: ${names.join(', ')}` })
    }

    if (evalCase.target === null) {
      if (evalCase.pdfs.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: '目录里有多份 PDF 时必须写 target（否则无法判定选对了哪一份）'
        })
      }
    } else if (!evalCase.pdfs.some((p) => p.name === evalCase.target)) {
      ctx.addIssue({ code: 'custom', message: `target ${evalCase.target} 不在 pdfs 里` })
    }

    const target = evalCase.pdfs.find((p) => p.name === (evalCase.target ?? evalCase.pdfs[0]?.name))
    if (target !== undefined) {
      const pageCount = target.pages.length
      for (const keyPoint of evalCase.keyPoints) {
        const out = keyPoint.pages.filter((p) => p > pageCount)
        if (out.length > 0) {
          ctx.addIssue({
            code: 'custom',
            message: `要点 ${keyPoint.id} 引用了不存在的页码 ${out.join(', ')}（${target.name} 只有 ${pageCount} 页）`
          })
        }
      }
    }

    const ids = evalCase.keyPoints.map((k) => k.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: `要点 id 重复: ${ids.join(', ')}` })
    }
  })

export const EvalCaseManifest = z.object({
  version: z.literal(1),
  cases: z.array(EvalCase).min(MIN_EVAL_CASES)
})

export type EvalCasePdf = z.infer<typeof EvalCasePdf>
export type EvalKeyPoint = z.infer<typeof EvalKeyPoint>
export type EvalCase = z.infer<typeof EvalCase>
export type EvalCaseManifest = z.infer<typeof EvalCaseManifest>

/** 清单读不出来或不合契约。清单坏了要立刻炸，不能让它静默少跑几条 case */
export class EvalManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalManifestError'
  }
}

export function parseCaseManifest(raw: unknown): EvalCaseManifest {
  const parsed = EvalCaseManifest.safeParse(raw)
  if (!parsed.success) {
    throw new EvalManifestError(`用例清单不符合契约: ${parsed.error.message}`)
  }
  const ids = parsed.data.cases.map((c) => c.id)
  if (new Set(ids).size !== ids.length) {
    throw new EvalManifestError(`用例 id 重复: ${ids.join(', ')}`)
  }
  return parsed.data
}

export function loadCaseManifest(path: string): EvalCaseManifest {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    throw new EvalManifestError(`用例清单读不出来: ${path} (${describe(e)})`)
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new EvalManifestError(`用例清单不是合法 JSON: ${path} (${describe(e)})`)
  }
  return parseCaseManifest(data)
}

/** 一个 case 的目标 PDF：写了 target 就用它，否则是唯一的那一份 */
export function targetPdf(evalCase: EvalCase): EvalCasePdf {
  const name = evalCase.target ?? evalCase.pdfs[0]?.name
  const found = evalCase.pdfs.find((p) => p.name === name)
  if (found === undefined) {
    throw new EvalManifestError(`case ${evalCase.id} 找不到目标 PDF: ${String(name)}`)
  }
  return found
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
