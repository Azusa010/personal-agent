import { CapabilityId } from '@personal-agent/protocol'

import {
  type CollectedEvidence,
  type VerificationCheck,
  type VerificationCheckId,
  type VerificationReport
} from './evidence-bundle'

/**
 * 交付物判定表 —— completed 的唯一闸口。
 *
 * 判定表是纯函数：输入是 evidence-bundle.ts 已查好的事实，输出是报告。
 * 不读库、不碰文件系统、不看时钟——同样的证据必须得到同样的结论。
 *
 * ## 契约
 *
 * 输入 `CollectedEvidence`（字段含义见 evidence-bundle.ts，全部是查出来的事实）
 * 输出 `VerificationReport`：
 *   - `checks`：每个 `VerificationCheckId` 各一条，`detail` 要写清「看到了什么 /
 *     缺了什么」，UI 与排障都直接读它；
 *   - `ok`：只有全部检查通过、且取证没有缺口才是 true；不通过时 run-task 把任务
 *     落成 failed，并写 `task_failed` 事件，稳定错误码 `RUNTIME_VERIFICATION_FAILED`；
 *   - `reason`：不通过时的一句话原因，通过时为 null。
 *
 * ## 不变量
 *
 * 1. **fail-closed**：拿不准就拒绝。「证据缺失」与「证据矛盾」都不能放行。
 * 2. **`gaps` 非空一定拒绝**：取证过程中读不出来的东西（PDF、文件系统、任务行）
 *    本身就是「无法证明交付」的证据——这条是总判定里的兜底，不依赖任何单项检查。
 * 3. **不采信单方自述**：`summary` 是 Python 的完成声明，页码必须落在
 *    `parsedPageNumbers`（重读真实 PDF 得到的页集合）里才算成立；判的是 facts
 *    里的引用，不是 `pageReferences` 这个派生数组。
 * 4. **交付物按计划要求**：计划里出现的 capability 才产生对应交付物的硬要求——
 *    有 extract_pdf 才要求页码落地、有 filesystem.move 才要求文件与批准、
 *    有 scheduler.create 才要求 Reminder。只读任务不该因为「没移动文件」被判失败；
 *    TASK-028 把计划扩成四步之后，同一条判定表自动开始要求文件与 Reminder。
 * 5. **被拒绝的操作也要查**：denied 的 Permission 必须没有对应的执行记录
 *    （PRD 3.7「被拒绝的操作没有产生副作用」）。
 *
 * ## 实现形状：两张表，不是一长串 if
 *
 * 每项检查是一条 `CheckSpec`：自己的判定函数 + 自己的「必需性」条件。
 * 新增一项检查 = 往 CHECKS 里加一行 + 在 `VERIFICATION_CHECK_IDS` 里加一个 id，
 * 总判定（`verifyDeliverables` 末尾）不动。
 *
 * 验收：`verify-deliverables.test.ts`。
 */

const EXTRACT_PDF_CAPABILITY = CapabilityId.enum['document.extract_pdf']
const MOVE_CAPABILITY = CapabilityId.enum['filesystem.move']
const SCHEDULER_CREATE_CAPABILITY = CapabilityId.enum['scheduler.create']

/** 单项检查的结论。detail 必须非空：UI 与排障都靠它解释「凭什么」。 */
interface CheckResult {
  ok: boolean
  detail: string
}

interface CheckSpec {
  id: VerificationCheckId
  /** 这一项在什么条件下参与总判定；不适用时记成通过 + notApplicable 说明。 */
  required: (evidence: CollectedEvidence) => boolean
  notApplicable: string
  run: (evidence: CollectedEvidence) => CheckResult
}

/** 计划里有没有带这个 capability 的步骤 */
function planHas(evidence: CollectedEvidence, capability: string): boolean {
  return evidence.planSteps.some((step) => step.capability === capability)
}

/** facts 里用到的页码（判定 grounding 用它，不用派生字段 pageReferences） */
function referencedPages(evidence: CollectedEvidence): number[] {
  const refs = new Set<number>()
  for (const fact of evidence.summary) {
    for (const ref of fact.pageRefs) refs.add(ref)
  }
  return [...refs].sort((a, b) => a - b)
}

function pass(detail: string): CheckResult {
  return { ok: true, detail }
}

function fail(detail: string): CheckResult {
  return { ok: false, detail }
}

const CHECKS: CheckSpec[] = [
  {
    id: 'summary_present',
    required: (evidence) => planHas(evidence, EXTRACT_PDF_CAPABILITY),
    notApplicable: '计划里没有提取 PDF 的步骤：摘要不依据页文本',
    run: (evidence) => {
      if (evidence.summary.length === 0) {
        return fail('没有任何 fact：模型没给出完成证据')
      }
      const withoutRefs = evidence.summary.filter((fact) => fact.pageRefs.length === 0)
      if (withoutRefs.length > 0) {
        return fail(`${withoutRefs.length} 条 fact 没有页码引用，无法追溯到页面`)
      }
      return pass(
        `${evidence.summary.length} 条 fact 都带页码引用（共 ${evidence.pageReferences.length} 个页码）`
      )
    }
  },
  {
    id: 'reply_present',
    required: () => true,
    notApplicable: '',
    run: (evidence) => {
      const reply = evidence.reply?.trim() ?? ''
      if (reply === '') {
        return fail('completed 缺少要说给用户的话（reply 缺失或为空）')
      }
      return pass(`回复非空（${evidence.reply?.length ?? 0} 字）`)
    }
  },
  {
    id: 'page_refs_grounded',
    required: (evidence) => planHas(evidence, EXTRACT_PDF_CAPABILITY),
    notApplicable: '计划里没有提取 PDF 的步骤：摘要不依据页文本',
    run: (evidence) => {
      const pages = evidence.parsedPageNumbers
      if (pages === null) {
        // 拿不到页集合 ≠ 页码可信：那等于把「无法取证」当成没问题
        return fail('没能重读真实 PDF，拿不到页集合，页码可信度无法判定')
      }
      if (pages.length === 0) {
        return fail('真实 PDF 一页都没读出来')
      }
      const missing = referencedPages(evidence).filter((ref) => !pages.includes(ref))
      if (missing.length > 0) {
        return fail(`页码 ${missing.join(', ')} 不在真实 PDF 的页集合里（共 ${pages.length} 页）`)
      }
      return pass(
        `摘要引用的 ${referencedPages(evidence).length} 个页码都在真实 PDF 的 ${pages.length} 页内`
      )
    }
  },
  {
    id: 'plan_steps_completed',
    required: () => true,
    notApplicable: '',
    run: (evidence) => {
      const steps = evidence.planSteps.filter(
        (step): step is { description: string; capability: string } => step.capability !== undefined
      )
      if (steps.length === 0) {
        return pass('计划里没有经工具的步骤')
      }
      const succeeded = new Map<string, number>()
      for (const call of evidence.toolResults) {
        if (!call.ok || !call.hasResult) continue
        succeeded.set(call.capability, (succeeded.get(call.capability) ?? 0) + 1)
      }
      const needed = new Map<string, number>()
      for (const step of steps) {
        needed.set(step.capability, (needed.get(step.capability) ?? 0) + 1)
      }
      const missing = [...needed]
        .filter(([capability, count]) => (succeeded.get(capability) ?? 0) < count)
        .map(
          ([capability, count]) =>
            `${capability}（需要 ${count} 次成功，实际 ${succeeded.get(capability) ?? 0} 次）`
        )
      if (missing.length > 0) {
        return fail(`计划步骤没跑完：${missing.join('；')}`)
      }
      return pass(`计划的 ${steps.length} 个工具步骤都有成功的执行结果`)
    }
  },
  {
    id: 'timeline_evidence',
    required: (evidence) => evidence.planSteps.some((step) => step.capability !== undefined),
    notApplicable: '本轮计划没有经工具的步骤：时间线不含工具调用',
    run: (evidence) => {
      if (evidence.eventSequenceRange === null) {
        return fail('这个任务一条事件都没有，时间线为空')
      }
      if (evidence.toolResults.length === 0) {
        return fail('时间线里没有任何工具调用：完成判断缺证据')
      }
      const pending = evidence.toolResults.filter((call) => !call.hasResult)
      if (pending.length > 0) {
        return fail(
          `${pending.length} 次工具调用没有结果（${pending.map((c) => c.callId).join(', ')}）：时间线不完整`
        )
      }
      return pass(
        `时间线 ${evidence.eventSequenceRange.from}–${evidence.eventSequenceRange.to}，` +
          `${evidence.toolResults.length} 次调用都有结果`
      )
    }
  },
  {
    id: 'permission_approved',
    required: (evidence) =>
      evidence.executions.length > 0 ||
      planHas(evidence, MOVE_CAPABILITY) ||
      planHas(evidence, SCHEDULER_CREATE_CAPABILITY),
    notApplicable: '本次没有产生任何副作用，不涉及批准',
    run: (evidence) => {
      const approvedHashes = new Set(
        evidence.permissions.filter((p) => p.status === 'approved').map((p) => p.argsHash)
      )
      const unapproved = evidence.executions.filter((x) => !approvedHashes.has(x.argsHash))
      if (unapproved.length > 0) {
        return fail(
          `有 ${unapproved.length} 次副作用没有对应的批准（${unapproved
            .map((x) => x.idempotencyKey)
            .join(', ')}）`
        )
      }
      return pass(`${evidence.executions.length} 次副作用都能对上批准的 Permission`)
    }
  },
  {
    id: 'denied_no_side_effect',
    required: () => true,
    notApplicable: '',
    run: (evidence) => {
      const deniedHashes = new Set(
        evidence.permissions.filter((p) => p.status === 'denied').map((p) => p.argsHash)
      )
      const violated = evidence.executions.filter((x) => deniedHashes.has(x.argsHash))
      if (violated.length > 0) {
        return fail(`被拒绝的调用留下了副作用：${violated.map((x) => x.idempotencyKey).join(', ')}`)
      }
      if (deniedHashes.size === 0) {
        return pass('本次没有被拒绝的调用')
      }
      return pass(`${deniedHashes.size} 条拒绝记录都没有产生副作用`)
    }
  },
  {
    id: 'file_at_target',
    required: (evidence) => planHas(evidence, MOVE_CAPABILITY),
    notApplicable: '计划里没有移动文件的步骤',
    run: (evidence) => {
      const landed = evidence.moves.find((move) => move.sourceGone && move.targetPresent)
      if (landed === undefined || evidence.finalFilePath === null) {
        return fail(
          `没有落到目标目录的移动（源已消失且目标存在）：最终路径 ${evidence.finalFilePath ?? '为空'}`
        )
      }
      return pass(`文件已从 ${landed.sourcePath} 移到 ${evidence.finalFilePath}`)
    }
  },
  {
    id: 'reminder_persisted',
    required: (evidence) => planHas(evidence, SCHEDULER_CREATE_CAPABILITY),
    notApplicable: '计划里没有创建提醒的步骤',
    run: (evidence) => {
      const reminder = evidence.reminder
      if (reminder === null) {
        return fail('库里没有该任务的 Reminder')
      }
      if (reminder.id === '' || reminder.idempotencyKey.trim() === '') {
        // PRD 3.7 要的是「已持久化并具有唯一幂等键」：缺任一半都不算
        return fail(`Reminder ${reminder.id || '（无 id）'} 缺 id 或幂等键`)
      }
      return pass(
        `Reminder ${reminder.id} 已持久化（${reminder.remindAt}，状态 ${reminder.status}）`
      )
    }
  }
]

export function verifyDeliverables(evidence: CollectedEvidence): VerificationReport {
  const checks: VerificationCheck[] = CHECKS.map((spec) =>
    spec.required(evidence)
      ? { id: spec.id, ...spec.run(evidence) }
      : { id: spec.id, ok: true, detail: spec.notApplicable }
  )

  const reasons = checks.filter((check) => !check.ok).map((check) => `${check.id}: ${check.detail}`)
  // 取证缺口是总判定里的兜底：即使某项检查没覆盖到它，也必须拒绝（fail-closed 底线）
  if (evidence.gaps.length > 0) {
    reasons.push(`取证缺口: ${evidence.gaps.join('；')}`)
  }

  return {
    ok: reasons.length === 0,
    checks,
    reason: reasons.length === 0 ? null : reasons.join(' / ')
  }
}

/** verification 三段事件。PRD 4.9 的事件名带点（verification.passed），
 *  仓库内既有事件（task_started / reminder_created…）都是下划线，
 *  这里跟随仓库惯例，避免同一条流里两种命名风格。 */
export const VERIFICATION_STARTED_EVENT = 'verification_started'
export const VERIFICATION_PASSED_EVENT = 'verification_passed'
export const VERIFICATION_FAILED_EVENT = 'verification_failed'
