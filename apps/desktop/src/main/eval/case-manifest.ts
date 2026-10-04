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

const RelativePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.startsWith('\\') && !p.includes('..') && !p.includes(':'),
    '相对路径不能是绝对路径，且不能包含 .. 逃逸或驱动器前缀'
  )

export const EvalCasePdf = z.object({
  name: FileName.refine((n) => n.toLowerCase().endsWith('.pdf'), 'PDF 文件名要以 .pdf 结尾'),
  relativePath: RelativePath.optional(),
  /** 逐页文本。**顺序即页码**（第 1 项是第 1 页），页数就是这份 PDF 的页数 */
  pages: z.array(PageTextInput).min(1)
})

export const EvalExtraFile = z.object({
  name: FileName,
  relativePath: RelativePath.optional(),
  content: z.string()
})

/**
 * 一个「应该出现在摘要里」的要点。
 *
 * - keywords：命中判据。facts 的正文里出现**任意一个**就算命中（大小写不敏感），
 *   所以要么挑模型无论用中文还是英文作答都会保留的字面量（数字、日期、专名），
 *   要么把两种写法都列上（`["重试风暴", "retry storm"]`）。
 * - text：scripted 模式下剧本里那一条 fact 的正文。
 * - pages：这条要点所在的页。支持跨文档引用对应 PDF。
 * - pdf：可选指定的 PDF 文件名（多文档比对场景）。缺省时归属 targetPdf。
 */
export const EvalKeyPoint = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    keywords: z.array(z.string().min(1)).min(1),
    pages: z.array(z.number().int().positive()).default([]),
    pdf: z.string().min(1).optional()
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

/** case 维度：读链路（PDF 摘要）、写链路（归档移动 + Reminder）、GAIA（复杂推理/沙箱计算）、τ-bench（状态跟踪/人机交互） */
export const EvalCaseType = z.enum([
  'pdf_summary',
  'stateful_ops',
  'gaia_reasoning',
  'tau_interactive'
])
export type EvalCaseType = z.infer<typeof EvalCaseType>

/** GAIA 数值计算期望定义 */
export const ExpectedCalculation = z.object({
  operation: z.string().min(1).optional(),
  expected: z.number(),
  tolerance: z.number().nonnegative().default(0.001)
})
export type ExpectedCalculation = z.infer<typeof ExpectedCalculation>

/** τ-bench 模拟权限决策行为（默认 approved） */
export const MockPermissionDecision = z.enum(['approved', 'denied'])
export type MockPermissionDecision = z.infer<typeof MockPermissionDecision>

/**
 * stateful_ops 的期望终态。判定与剧本合成都读它——「case 想要什么」只有这一处。
 *
 * dir 固定 Reading：planning.py 的 WRITE_STEPS 文案写死了「创建 Reading 目录」，
 * live 模型看到的计划与清单必须说同一件事，否则模型被两头拉扯。要改目录名，
 * 先改 planning.py 的文案，再放开这里的约束（case-manifest.test.ts 钉着这条）。
 */
export const EvalStatefulExpectation = z.object({
  dir: z.literal('Reading'),
  /** Reminder 的正文。剧本直接用它；终态判定只要求 Reminder 行存在（闸口已查） */
  reminderMessage: z.string().min(1)
})
export type EvalStatefulExpectation = z.infer<typeof EvalStatefulExpectation>

export const EvalCase = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'id 用小写字母数字与短横线'),
    goal: z.string().min(1),
    /** 难度等级：1 = 基础单步/单文档检索，2 = 复合多文档/嵌套目录/代码计算，3 = 高级长链路自主规划 */
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    /** 缺省是 pdf_summary：version 1 的清单全部是读链路，不用逐条补 type */
    type: EvalCaseType.default('pdf_summary'),
    /**
     * 落进这次任务的授权根。顺序有含义：按清单顺序写入，每份比前一份晚 1 分钟
     * 落盘——「最近改过的那份」这类目标因此是确定的，最后一份最新。
     */
    pdfs: z.array(EvalCasePdf).min(1),
    /** 混在目录里的非 PDF 文件：filesystem_list 只列 PDF，这些是选择干扰项 */
    extraFiles: z.array(EvalExtraFile).default([]),
    /** 期望被提取的那份 PDF。null 只在目录里只有一份 PDF 或交互澄清类用例中合法 */
    target: z.string().min(1).nullable().default(null),
    /** 期望提取的多份目标 PDF（如多文档交叉分析） */
    targets: z.array(z.string().min(1)).optional(),
    keyPoints: z.array(EvalKeyPoint).default([]),
    /** type=stateful_ops 时必填（期望终态）；其他类型必须缺省 */
    stateful: EvalStatefulExpectation.optional(),
    /** GAIA 专用：期望的数值结果与误差容限 */
    expectedCalculation: ExpectedCalculation.optional(),
    /** τ-bench 专用：是否期望主动澄清提问 */
    clarificationExpected: z.boolean().optional(),
    /** 期望回复中包含的关键问询/回复关键词 */
    expectedReplyKeywords: z.array(z.string().min(1)).optional(),
    /** τ-bench 专用：模拟权限审批动作（approved/denied） */
    mockPermissionDecision: MockPermissionDecision.optional()
  })
  .superRefine((evalCase, ctx) => {
    if (evalCase.type === 'stateful_ops' && evalCase.stateful === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `stateful_ops case ${evalCase.id} 必须写 stateful（期望终态）`
      })
    }
    if (
      evalCase.type !== 'stateful_ops' &&
      evalCase.type !== 'tau_interactive' &&
      evalCase.stateful !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `${evalCase.type} case ${evalCase.id} 不该写 stateful（那是写链路或状态交互的字段）`
      })
    }

    const filePaths = [
      ...evalCase.pdfs.map((p) => p.relativePath ?? p.name),
      ...evalCase.extraFiles.map((f) => f.relativePath ?? f.name)
    ]
    if (new Set(filePaths).size !== filePaths.length) {
      ctx.addIssue({
        code: 'custom',
        message: `同一目录或相对路径下文件名重复: ${filePaths.join(', ')}`
      })
    }

    for (const pdf of evalCase.pdfs) {
      if (pdf.relativePath) {
        const base = pdf.relativePath.split(/[/\\]/).pop()
        if (base !== pdf.name) {
          ctx.addIssue({
            code: 'custom',
            message: `PDF relativePath "${pdf.relativePath}" 的文件名与 name "${pdf.name}" 不一致`
          })
        }
      }
    }
    for (const extra of evalCase.extraFiles) {
      if (extra.relativePath) {
        const base = extra.relativePath.split(/[/\\]/).pop()
        if (base !== extra.name) {
          ctx.addIssue({
            code: 'custom',
            message: `extraFile relativePath "${extra.relativePath}" 的文件名与 name "${extra.name}" 不一致`
          })
        }
      }
    }

    const pdfNames = evalCase.pdfs.map((p) => p.name)

    // target 校验
    if (evalCase.type === 'pdf_summary' || evalCase.type === 'stateful_ops') {
      if (evalCase.target === null) {
        if (evalCase.pdfs.length !== 1) {
          ctx.addIssue({
            code: 'custom',
            message: '目录里有多份 PDF 时必须写 target（否则无法判定选对了哪一份）'
          })
        }
      } else if (!pdfNames.includes(evalCase.target)) {
        ctx.addIssue({ code: 'custom', message: `target ${evalCase.target} 不在 pdfs 里` })
      }
      if (evalCase.keyPoints.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${evalCase.type} 用例 ${evalCase.id} 必须至少包含一个 keyPoint`
        })
      }
    } else if (evalCase.type === 'gaia_reasoning') {
      if (evalCase.targets) {
        for (const t of evalCase.targets) {
          if (!pdfNames.includes(t)) {
            ctx.addIssue({ code: 'custom', message: `targets 里的 ${t} 不在 pdfs 里` })
          }
        }
      }
      if (evalCase.target !== null && !pdfNames.includes(evalCase.target)) {
        ctx.addIssue({ code: 'custom', message: `target ${evalCase.target} 不在 pdfs 里` })
      }
    } else if (evalCase.type === 'tau_interactive') {
      if (
        !evalCase.clarificationExpected &&
        evalCase.target !== null &&
        !pdfNames.includes(evalCase.target)
      ) {
        ctx.addIssue({ code: 'custom', message: `target ${evalCase.target} 不在 pdfs 里` })
      }
    }

    // keyPoints 页码范围与 PDF 归属校验
    const pdfMap = new Map(evalCase.pdfs.map((p) => [p.name, p]))
    const fallbackTarget = evalCase.pdfs.find(
      (p) => p.name === (evalCase.target ?? evalCase.targets?.[0] ?? evalCase.pdfs[0]?.name)
    )

    for (const keyPoint of evalCase.keyPoints) {
      const referencedPdf = keyPoint.pdf ? pdfMap.get(keyPoint.pdf) : fallbackTarget
      if (keyPoint.pdf && !referencedPdf) {
        ctx.addIssue({
          code: 'custom',
          message: `要点 ${keyPoint.id} 指向的 pdf "${keyPoint.pdf}" 不在 pdfs 清单中`
        })
        continue
      }
      if (referencedPdf) {
        const pageCount = referencedPdf.pages.length
        const out = keyPoint.pages.filter((p) => p > pageCount)
        if (out.length > 0) {
          ctx.addIssue({
            code: 'custom',
            message: `要点 ${keyPoint.id} 引用了不存在的页码 ${out.join(', ')}（${referencedPdf.name} 只有 ${pageCount} 页）`
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

/** 一个 case 的目标 PDF：写了 target 就用它，多目标时取首个，否则是唯一的那一份 */
export function targetPdf(evalCase: EvalCase): EvalCasePdf {
  const name = evalCase.target ?? evalCase.targets?.[0] ?? evalCase.pdfs[0]?.name
  const found = evalCase.pdfs.find((p) => p.name === name)
  if (found === undefined) {
    throw new EvalManifestError(`case ${evalCase.id} 找不到目标 PDF: ${String(name)}`)
  }
  return found
}

/** 获取一个 case 的所有目标 PDF（多文档比对或单文档） */
export function targetPdfs(evalCase: EvalCase): EvalCasePdf[] {
  if (evalCase.targets && evalCase.targets.length > 0) {
    return evalCase.pdfs.filter((p) => evalCase.targets!.includes(p.name))
  }
  const single = targetPdf(evalCase)
  return single ? [single] : []
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
