/**
 * 交付物判定表（TASK-026）的验收 —— 指导书 Validation 列：
 * **缺任一交付物时禁止 completed**。
 *
 * 这份文件是「验证与质量」的练习场（AGENTS.md §6）：场景、数据与期望行为的文字描述
 * 由 AI 给，**`expect(...)` 由你写**。写断言的过程就是读懂 verify-deliverables.ts 的过程；
 * 每个用例末尾的「期望」就是判定表必须满足的规格。
 *
 * 写法：待补断言的用例里保留了一次 `verifyDeliverables(...)` 调用（占位实现会在那里抛错
 * →红），你把它接住即可：
 *
 *     const report = verifyDeliverables(evidence({ summary: [] }))
 *     expect(report.ok).toBe(false)
 *     expect(checkOf(report, 'summary_present').ok).toBe(false)
 *
 * 保留给 AI 的两类断言（契约底线，不随陪练交出去）：
 *   1. 「报告结构」——检查项齐全、id 不重复、每项都有非空 detail；
 *   2. 「fail-closed 底线」——取证有缺口时必须拒绝（闸口坏了不能变成敞开的门）。
 *
 * 证据形状的两个基准：
 *   - FULL_PLAN：Golden Path 的四步计划（list / extract / move / scheduler.create），
 *     交付物齐备时八项检查全过；
 *   - READ_ONLY_PLAN：只读三步计划（list / extract / summary），
 *     文件与 Reminder 不是它的交付物——判定表要按计划要求，不能照搬固定清单，
 *     否则只读任务的 20 轮 E2E 会被判失败。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PlanStep } from '../../shared/domain'
import {
  VERIFICATION_CHECK_IDS,
  type CollectedEvidence,
  type VerificationCheck,
  type VerificationCheckId,
  type VerificationReport
} from './evidence-bundle'
import { verifyDeliverables } from './verify-deliverables'

const PDF = 'D:/downloads/report.pdf'
const READING = 'D:/downloads/Reading/report.pdf'

const FULL_PLAN: PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '把选中的 PDF 移到 Reading', capability: 'filesystem.move' },
  { description: '创建阅读提醒', capability: 'scheduler.create' }
]

const READ_ONLY_PLAN: PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '基于页面内容生成带页码引用的摘要' }
]

const FULL: CollectedEvidence = {
  taskId: 't-1',
  goal: '整理 Downloads 里的 PDF，放到 Reading，并提醒我今晚读',
  planVersion: 1,
  planSteps: FULL_PLAN,
  summary: [{ text: '第一页与第三页讲了同一件事', pageRefs: [1, 3] }],
  reply: '已把报告移到 Reading，摘要见下。',
  pageReferences: [1, 3],
  selectedPdf: PDF,
  resolvedPdfPath: READING,
  parsedPageNumbers: [1, 2, 3],
  parsedPageCount: 3,
  toolResults: [
    { callId: 'c-list', capability: 'filesystem.list', ok: true, hasResult: true },
    { callId: 'c-extract', capability: 'document.extract_pdf', ok: true, hasResult: true },
    { callId: 'c-move', capability: 'filesystem.move', ok: true, hasResult: true },
    { callId: 'c-remind', capability: 'scheduler.create', ok: true, hasResult: true }
  ],
  permissions: [
    {
      toolCallId: 'c-move',
      capability: 'filesystem.move',
      status: 'approved',
      argsHash: 'h-move'
    }
  ],
  executions: [
    {
      idempotencyKey: 'filesystem.move:h-move',
      capability: 'filesystem.move',
      argsHash: 'h-move',
      status: 'succeeded',
      sourcePaths: [PDF],
      targetPath: READING
    }
  ],
  moves: [{ sourcePath: PDF, targetPath: READING, sourceGone: true, targetPresent: true }],
  finalFilePath: READING,
  reminder: {
    id: 'r-1',
    remindAt: '2026-09-15T20:00:00.000Z',
    status: 'scheduled',
    idempotencyKey: 'scheduler.create:h-remind'
  },
  eventSequenceRange: { from: 1, to: 10 },
  gaps: []
}

const READ_ONLY: CollectedEvidence = {
  ...FULL,
  goal: '总结 Downloads 里的 PDF',
  planSteps: READ_ONLY_PLAN,
  toolResults: FULL.toolResults.slice(0, 2),
  permissions: [],
  executions: [],
  moves: [],
  finalFilePath: null,
  reminder: null
}

function evidence(overrides: Partial<CollectedEvidence> = {}): CollectedEvidence {
  return { ...FULL, ...overrides }
}

/** 取某一项检查。判定表必须给出全部八项，缺了就在这里炸——而不是断言悄悄通过。 */
function checkOf(report: VerificationReport, id: VerificationCheckId): VerificationCheck {
  const found = report.checks.find((c) => c.id === id)
  if (found === undefined) throw new Error(`报告里没有检查项 ${id}`)
  return found
}

// ---------------------------------------------------------------------------
// 契约底线（AI 保留）
// ---------------------------------------------------------------------------

describe('判定表：报告结构', () => {
  it('八项检查一项不少、id 不重复', () => {
    const report = verifyDeliverables(FULL)
    // 落库的 Evidence Bundle 要能被逐项核对，少一项就少一条核对依据。
    expect(report.checks.map((c) => c.id).sort()).toEqual([...VERIFICATION_CHECK_IDS].sort())
    expect(new Set(report.checks.map((c) => c.id)).size).toBe(VERIFICATION_CHECK_IDS.length)
  })

  it('是纯函数：同一份证据两次结论一致', () => {
    expect(verifyDeliverables(FULL)).toEqual(verifyDeliverables(FULL))
  })

  it('每项检查都带非空 detail（UI 与排障都读它，空字符串等于没有解释）', () => {
    const report = verifyDeliverables(FULL)

    for (const id of VERIFICATION_CHECK_IDS) {
      expect(checkOf(report, id).detail.trim().length, `${id} 的 detail 不能为空`).toBeGreaterThan(
        0
      )
    }
  })
})

describe('判定表：fail-closed 底线', () => {
  it('取证有缺口（PDF / 文件系统读不出来）→ 整体拒绝', () => {
    const report = verifyDeliverables(evidence({ gaps: ['重读真实 PDF 失败: PDF_CORRUPT'] }))

    // 缺口本身就是「无法证明交付」的证据，任何一项检查都不该把它洗干净。
    expect(report.ok).toBe(false)
    expect(report.reason).not.toBeNull()
  })
})

describe('判定表：陪练点收口', () => {
  it('verification/ 下不再有待填标记（标记清零 = 陪练点真的填完了）', () => {
    // 「断言由你写」的用例在补上 expect 之前是**静默绿**的——调用没抛错而已。
    // 这条按 AGENTS.md §6 的标记约定兜底：本目录下标记清零，才算这一轮的陪练结束。
    const self = basename(fileURLToPath(import.meta.url))
    const dir = dirname(fileURLToPath(import.meta.url))
    const marker = ['TODO', '(你填)'].join('')

    const remaining = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && name !== self)
      .flatMap((name) =>
        readFileSync(join(dir, name), 'utf8')
          .split('\n')
          .map((line, index) => ({ at: `${name}:${index + 1}`, hit: line.includes(marker) }))
          .filter((row) => row.hit)
          .map((row) => row.at)
      )

    expect(remaining).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 判定用例：每条只改证据的一个字段，钉住「哪一项检查必须拦住」
// ---------------------------------------------------------------------------

describe('判定表：放行', () => {
  it('四步计划的交付物齐备 → 全部通过', () => {
    const report = verifyDeliverables(FULL)

    expect(report.ok).toBe(true)
    expect(report.checks.filter((check) => !check.ok)).toEqual([])
    expect(report.reason).toBeNull()
  })

  it('只读计划不因「没移动文件、没建提醒」被判失败', () => {
    const report = verifyDeliverables(READ_ONLY)

    expect(report.ok).toBe(true)
    // 不适用 ≠ 未通过：这三项对只读计划都不构成拒绝
    for (const id of ['file_at_target', 'reminder_persisted', 'permission_approved'] as const) {
      expect(checkOf(report, id).ok, `${id} 对只读任务应当不构成拒绝`).toBe(true)
    }
  })
})

describe('判定表：缺摘要 / 页码不可信', () => {
  it('摘要为空 → summary_present 不过', () => {
    const report = verifyDeliverables(evidence({ summary: [], pageReferences: [] }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'summary_present').ok).toBe(false)
    expect(checkOf(report, 'summary_present').detail).toContain('fact')
    expect(report.reason).not.toBeNull()
  })

  it('某条 fact 没有页码引用 → summary_present 不过', () => {
    const summary = [{ text: '没有出处的结论', pageRefs: [] }]
    const report = verifyDeliverables(evidence({ summary }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'summary_present').ok).toBe(false)
    // 拦住它的是「摘要结构」，不是「页码落地」——后者对空引用无从判起
    expect(checkOf(report, 'page_refs_grounded').ok).toBe(true)
  })

  it('页码引用落在重读页集合之外 → page_refs_grounded 不过', () => {
    // 摘要引用了第 9 页，但真实 PDF 只有 3 页：这是编造的证据。
    const summary = [{ text: '第九页的说法', pageRefs: [9] }]
    const report = verifyDeliverables(evidence({ summary, pageReferences: [9] }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'page_refs_grounded').ok).toBe(false)
    expect(checkOf(report, 'page_refs_grounded').detail).toContain('9')
  })

  it('重读不出真实页号 → page_refs_grounded 不过（拿不到页集合不等于页码可信）', () => {
    const report = verifyDeliverables(evidence({ parsedPageNumbers: null, parsedPageCount: null }))

    expect(report.ok).toBe(false)
    // 拿不到页集合就跳过这项 = 把「无法取证」当成没问题
    expect(checkOf(report, 'page_refs_grounded').ok).toBe(false)
  })

  it('summary 多出未出现在 pageReferences 里的页码 → 仍以重读页集合为准', () => {
    // pageReferences 是派生字段，判定表不该只信它：facts 里引用的第 4 页不存在。
    const summary = [{ text: '第四页的说法', pageRefs: [1, 4] }]
    const report = verifyDeliverables(evidence({ summary, pageReferences: [1, 4] }))

    expect(report.ok).toBe(false)
    // 判的是 facts 里的引用，不是 pageReferences 这个派生数组
    expect(checkOf(report, 'page_refs_grounded').ok).toBe(false)
    expect(checkOf(report, 'page_refs_grounded').detail).toContain('4')
  })
})

describe('判定表：缺文件 / 文件位置不对', () => {
  it('计划要移动文件，但没有任何成功的移动 → file_at_target 不过', () => {
    const report = verifyDeliverables(evidence({ moves: [], finalFilePath: null }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'file_at_target').ok).toBe(false)
  })

  it('源路径还在（移动其实没发生）→ file_at_target 不过', () => {
    const moves = [{ sourcePath: PDF, targetPath: READING, sourceGone: false, targetPresent: true }]
    const report = verifyDeliverables(evidence({ moves }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'file_at_target').ok).toBe(false)
  })

  it('目标路径不存在（文件不在目标目录）→ file_at_target 不过', () => {
    const moves = [{ sourcePath: PDF, targetPath: READING, sourceGone: true, targetPresent: false }]
    const report = verifyDeliverables(evidence({ moves, finalFilePath: null }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'file_at_target').ok).toBe(false)
  })

  it('最终路径为空 → file_at_target 不过', () => {
    const report = verifyDeliverables(evidence({ finalFilePath: null }))

    expect(report.ok).toBe(false)
    // moves 齐备但最终路径为空：两者都要对得上，不能只看其中一个
    expect(checkOf(report, 'file_at_target').ok).toBe(false)
  })
})

describe('判定表：缺 Reminder', () => {
  it('计划要建提醒，但库里没有 Reminder → reminder_persisted 不过', () => {
    const report = verifyDeliverables(evidence({ reminder: null }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'reminder_persisted').ok).toBe(false)
  })

  it('Reminder 没有幂等键 → reminder_persisted 不过', () => {
    const reminder = {
      id: 'r-1',
      remindAt: '2026-09-15T20:00:00.000Z',
      status: 'scheduled' as const,
      idempotencyKey: ''
    }
    const report = verifyDeliverables(evidence({ reminder }))

    expect(report.ok).toBe(false)
    // PRD 3.7 要的是「已持久化并具有唯一幂等键」，空键不算
    expect(checkOf(report, 'reminder_persisted').ok).toBe(false)
  })
})

describe('判定表：计划步骤与时间线证据', () => {
  it('计划里的 move 步骤没有成功的 tool_result → plan_steps_completed 不过', () => {
    const toolResults = FULL.toolResults.filter((t) => t.capability !== 'filesystem.move')
    const report = verifyDeliverables(evidence({ toolResults }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'plan_steps_completed').ok).toBe(false)
    expect(checkOf(report, 'plan_steps_completed').detail).toContain('filesystem.move')
  })

  it('计划步骤的调用只有请求没有结果（hasResult:false）→ plan_steps_completed 不过', () => {
    const toolResults = [
      ...FULL.toolResults.slice(0, 2),
      { callId: 'c-move', capability: 'filesystem.move', ok: false, hasResult: false },
      FULL.toolResults[3]!
    ]
    const report = verifyDeliverables(evidence({ toolResults }))

    expect(report.ok).toBe(false)
    // 「没回来」和「回来了但失败」都不是「已完成」
    expect(checkOf(report, 'plan_steps_completed').ok).toBe(false)
  })

  it('时间线里一条工具调用都没有 → timeline_evidence 不过', () => {
    const report = verifyDeliverables(evidence({ toolResults: [] }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'timeline_evidence').ok).toBe(false)
  })

  it('事件序号区间缺失（拿不到时间线）→ timeline_evidence 不过', () => {
    const report = verifyDeliverables(evidence({ eventSequenceRange: null }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'timeline_evidence').ok).toBe(false)
  })
})

describe('判定表：权限与已拒绝的操作', () => {
  it('WRITE 步骤没有 approved 的 Permission → permission_approved 不过', () => {
    const report = verifyDeliverables(evidence({ permissions: [] }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'permission_approved').ok).toBe(false)
    expect(checkOf(report, 'permission_approved').detail).toContain('没有对应的批准')
  })

  it('Permission 只是 pending → permission_approved 不过', () => {
    const permissions = [{ ...FULL.permissions[0]!, status: 'pending' as const }]
    const report = verifyDeliverables(evidence({ permissions }))

    expect(report.ok).toBe(false)
    // 只有 approved 才算批准：pending 也是没批准
    expect(checkOf(report, 'permission_approved').ok).toBe(false)
  })

  it('Permission 与实际执行的参数哈希对不上 → permission_approved 不过', () => {
    // 批准的是 A 参数，执行的是 B 参数：参数篡改必须在这里被看见。
    const executions = [{ ...FULL.executions[0]!, argsHash: 'h-tampered' }]
    const report = verifyDeliverables(evidence({ executions }))

    expect(report.ok).toBe(false)
    // 有 approved 但哈希不同 = 批准的是 A 参数、执行的是 B 参数
    expect(checkOf(report, 'permission_approved').ok).toBe(false)
  })

  it('denied 的调用却留下了成功的副作用 → denied_no_side_effect 不过', () => {
    const permissions = [
      ...FULL.permissions,
      {
        toolCallId: 'c-move-2',
        capability: 'filesystem.move',
        status: 'denied' as const,
        argsHash: 'h-denied'
      }
    ]
    const executions = [
      ...FULL.executions,
      {
        idempotencyKey: 'filesystem.move:h-denied',
        capability: 'filesystem.move',
        argsHash: 'h-denied',
        status: 'succeeded' as const,
        sourcePaths: [PDF],
        targetPath: READING
      }
    ]
    const report = verifyDeliverables(evidence({ permissions, executions }))

    expect(report.ok).toBe(false)
    // PRD 3.7：被拒绝的操作没有产生副作用
    expect(checkOf(report, 'denied_no_side_effect').ok).toBe(false)
    expect(checkOf(report, 'denied_no_side_effect').detail).toContain('h-denied')
  })

  it('denied 的调用没有任何执行记录 → 这一项通过（拒绝是有效的）', () => {
    const permissions = [
      ...FULL.permissions,
      {
        toolCallId: 'c-move-2',
        capability: 'filesystem.move',
        status: 'denied' as const,
        argsHash: 'h-denied'
      }
    ]
    const report = verifyDeliverables(evidence({ permissions }))

    // 拒绝之后什么都没发生：这正是我们要的结果，不能把「有 denied 记录」当成问题
    expect(checkOf(report, 'denied_no_side_effect').ok).toBe(true)
    expect(checkOf(report, 'denied_no_side_effect').detail).toContain('没有产生副作用')
  })
})

// ---------------------------------------------------------------------------
// 零工具轮次与 reply（TASK-031）
// ---------------------------------------------------------------------------

const CHAT_REPLY = '你好！我可以帮你整理 Downloads 里的 PDF。'

/** 零工具计划的证据包：计划只有一步「直接回答」，没有任何工具调用与交付物。 */
function zeroToolEvidence(overrides: Partial<CollectedEvidence> = {}): CollectedEvidence {
  return evidence({
    goal: '你好',
    planSteps: [{ description: '直接回答用户' }],
    summary: [],
    pageReferences: [],
    selectedPdf: null,
    resolvedPdfPath: null,
    parsedPageNumbers: null,
    parsedPageCount: null,
    toolResults: [],
    permissions: [],
    executions: [],
    moves: [],
    finalFilePath: null,
    reminder: null,
    reply: CHAT_REPLY,
    ...overrides
  })
}

describe('零工具轮次与 reply（TASK-031）', () => {
  it('零工具计划 + 非空 reply → 整体通过：这就是「你好」轮能 completed 的判定', () => {
    const report = verifyDeliverables(zeroToolEvidence())

    expect(report.ok).toBe(true)
    // 两项对固定流程有意义的检查，在零工具轮次如实标注不适用
    expect(checkOf(report, 'summary_present').detail).toContain('没有提取 PDF')
    expect(checkOf(report, 'timeline_evidence').detail).toContain('没有经工具')
  })

  it('reply 缺失（null）→ 拒绝：completed 必须有要说给用户的话', () => {
    const report = verifyDeliverables(zeroToolEvidence({ reply: null }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'reply_present').ok).toBe(false)
  })

  it('reply 是纯空白 → 拒绝：空泡在界面上等于没有回答', () => {
    const report = verifyDeliverables(zeroToolEvidence({ reply: '   ' }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'reply_present').ok).toBe(false)
  })

  it('reply_present 对完整 Golden Path 同样生效（两档共用这条底线）', () => {
    const report = verifyDeliverables(evidence({ reply: null }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'reply_present').ok).toBe(false)
  })

  it('计划有 extract_pdf 但一个 fact 都没有 → summary_present 照旧拒绝（分档不豁免承诺）', () => {
    const report = verifyDeliverables(evidence({ summary: [], pageReferences: [] }))

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'summary_present').ok).toBe(false)
  })
})
