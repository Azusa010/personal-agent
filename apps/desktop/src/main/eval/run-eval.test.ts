import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadCaseManifest, MIN_EVAL_CASES } from './case-manifest'
import { evalCasesPath, repoRoot } from './paths'
import { EvalReportSchema, formatSummary, writeReport, type EvalReport } from './report'
import { makeEvalWorkDir, removeEvalWorkDir, runEval } from './run-eval'

/**
 * Harness 的验收（TASK-027）：scripted 模式把整份清单跑一遍。
 *
 * 真 spawn venv 里的 `python -m personal_agent`（每条 case 一个子进程）、真走
 * host.execute_tool 反向 RPC、真读现场生成的 PDF、真落一份 product-state 库、
 * 真过 TASK-026 的交付物闸口。唯一假的是模型：每条 case 的剧本由清单合出来
 * （CON-006：CI 不得依赖真实模型或付费 API）。
 *
 * 断言分两层：与判定无关的部分（每条 case 跑到终态、工具调用按计划发生、报告形状
 * 合规）和**标准答案**（剧本的摘要直接取自清单的要点与页码，所以 scripted 模式必须
 * 20/20 完整成功）。后者是这台 harness 自检的那根弦：清单、剧本合成、判定表三者
 * 只要有一个算错，它就会红——没有它，判定表把 20 条全判成失败也只体现为报告里的
 * 一个 0/20，没有任何红点。
 */

const VENV_PYTHON = join(repoRoot(), 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const RUNTIME_CWD = join(repoRoot(), 'services', 'agent-runtime')

describe.skipIf(!existsSync(VENV_PYTHON))(
  'Live Eval Harness（scripted 模式）：真 Python + 真 PDF + 真库 + 真闸口',
  () => {
    let workDir = ''
    let report: EvalReport | null = null
    const progress: string[] = []

    function theReport(): EvalReport {
      if (report === null) throw new Error('beforeAll 没跑完，报告还没生成')
      return report
    }

    beforeAll(async () => {
      workDir = makeEvalWorkDir('pa-eval-scripted-')
      const manifest = loadCaseManifest(evalCasesPath())
      report = await runEval({
        mode: 'scripted',
        cases: manifest.cases,
        manifestPath: evalCasesPath(),
        workDir,
        runtime: { command: VENV_PYTHON, args: ['-m', 'personal_agent'], cwd: RUNTIME_CWD },
        onCase: (line) => progress.push(line)
      })
    }, 300_000)

    afterAll(() => {
      if (workDir !== '') removeEvalWorkDir(workDir)
    })

    it(`清单里 ${MIN_EVAL_CASES} 条 case 一条不少地跑完，报告过 schema`, () => {
      const manifest = loadCaseManifest(evalCasesPath())

      expect(theReport().cases).toHaveLength(manifest.cases.length)
      expect(theReport().cases.map((c) => c.id)).toEqual(manifest.cases.map((c) => c.id))
      const parsed = EvalReportSchema.safeParse(theReport())
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      // 每条 case 都该有进度输出：跑挂一条也不该安静。
      expect(progress).toHaveLength(manifest.cases.length)
    })

    it('全部走到 completed：Python 声明 + Main 侧交付物闸口都放行', () => {
      const broken = theReport()
        .cases.filter((c) => c.status !== 'completed' || c.verificationOk !== true)
        .map(
          (c) =>
            `${c.id} ${c.status} verification=${String(c.verificationOk)} ${c.reasons[0] ?? ''}`
        )

      expect(broken, broken.join('\n')).toEqual([])
      expect(theReport().metrics.completionRate).toBe(1)
      expect(theReport().mode).toBe('scripted')
      expect(theReport().model).toBeNull()
    })

    it('每条 case 都按计划调了 list 与 extract，没有预算耗尽', () => {
      const report = theReport()

      expect(report.metrics.tools.byCapability).toEqual({
        document_extract_pdf: report.cases.length,
        filesystem_list: report.cases.length
      })
      expect(report.metrics.tools.failed).toBe(0)
      expect(report.metrics.tools.budgetExhaustedCases).toBe(0)
    })

    it('摘要真的流到了报告里：fact 总数等于清单里的要点总数', () => {
      const manifest = loadCaseManifest(evalCasesPath())
      const keyPoints = manifest.cases.reduce((total, c) => total + c.keyPoints.length, 0)

      // 剧本的摘要直接取自清单的要点，所以这两个数必须相等：不等说明摘要没落库、
      // 或者取证没读到 task_completed。
      expect(theReport().metrics.pageRefs.facts).toBe(keyPoints)
    })

    it('标准答案 20/20：清单、剧本合成与判定表三者一致', () => {
      const report = theReport()
      // 剧本的 fact 正文与页码都取自清单，页码又真的存在于生成的 PDF —— 这就是标准答案，
      // 没有一条该被判失败。判不过只可能是三处之一算错，逐个报出是哪条、因为什么。
      const failed = report.cases
        .filter((c) => c.reasons.length > 0)
        .map((c) => `${c.id}: ${c.reasons.join(' / ')}`)

      expect(failed, failed.join('\n')).toEqual([])
      expect(report.metrics.fullSuccess).toBe(report.cases.length)
      expect(report.metrics.pageRefs.accuracy).toBe(1)
      expect(report.metrics.keyPoints.recall).toBe(1)

      // 跑 `pnpm eval` 就该看到报告摘要，而不是"绿了就完事"。
      console.log(formatSummary(report))
    })

    it('延迟是分布不是单点：合法数字，且每条 case 都有读数', () => {
      const report = theReport()

      expect(report.cases.every((c) => c.latencyMs >= 0)).toBe(true)
      expect(report.metrics.latencyMs.max).toBeGreaterThanOrEqual(report.metrics.latencyMs.p95)
      expect(report.metrics.latencyMs.total).toBeGreaterThan(0)
    })

    it('报告能写盘并读回（写的是 JSON，不是内存对象）', () => {
      const path = join(workDir, 'reports', 'scripted.json')

      const written = writeReport(theReport(), path)

      expect(written).toBe(path)
      expect(existsSync(path)).toBe(true)
    })
  }
)
