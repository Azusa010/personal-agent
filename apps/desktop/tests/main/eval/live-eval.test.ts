import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadCaseManifest } from '../../../src/main/eval/case-manifest'
import { pricingFromEnv } from '../../../src/main/eval/metrics'
import { defaultReportDir, evalCasesPath, repoRoot } from '../../../src/main/eval/paths'
import {
  buildReport,
  EvalReportSchema,
  formatSummary,
  writeReport
} from '../../../src/main/eval/report'
import {
  LIVE_MODEL_ENV,
  makeEvalWorkDir,
  removeEvalWorkDir,
  runEval
} from '../../../src/main/eval/run-eval'

/**
 * Live Eval：真模型敞开跑（TEST-013 / REQ-011）。
 *
 * 不进 CI：没配 OPENAI_MODEL + OPENAI_API_KEY 时整块跳过（CON-006：CI 不得依赖
 * 真实随机模型或付费 API）。人手跑：
 *
 *   EVAL_LIVE=1 OPENAI_MODEL=<模型名> OPENAI_API_KEY=<key> pnpm eval:live
 *
 * 想连成本一起统计，再加两个单价（USD / 百万 token）：
 *   EVAL_PRICE_INPUT_PER_MTOK=… EVAL_PRICE_OUTPUT_PER_MTOK=…
 *
 * 这里**不断言**合格线：模型的通过与否是跑出来的结论，写在报告的 gates 里
 * （完整成功 ≥18/20、页码准确率 ≥95%、关键结论召回 ≥90%）。测试只保证
 * 「跑完了、报告写下来了、形状合规」——把阈值写成断言，模型偶发波动时
 * 测试会红成"代码坏了"，而它坏的是分数。
 */

const VENV_PYTHON = join(repoRoot(), 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const RUNTIME_CWD = join(repoRoot(), 'services', 'agent-runtime')

const enabled =
  process.env['EVAL_LIVE'] === '1' &&
  (process.env[LIVE_MODEL_ENV] ?? '') !== '' &&
  (process.env['OPENAI_API_KEY'] ?? '') !== '' &&
  existsSync(VENV_PYTHON)

if (!enabled) {
  // 跳过要出声：跑了 `pnpm eval:live` 却什么都没发生，最容易的误解是"跑过了、通过了"。
  console.warn(
    'Live Eval 未开启（缺 EVAL_LIVE=1 / OPENAI_MODEL / OPENAI_API_KEY），本次跳过。跑法见 tests/evals/README.md'
  )
} else {
  // 报告（live-<时间戳>.json）在**全部 case 跑完后**写一次；过程中的 [PASS]/[FAIL]
  // 是逐条进度，失败 case 的 trace 会即时落盘，报告不会。
  console.log('Live Eval 开始：报告在全部跑完后写 reports/，失败 case 的 trace 即时落盘。')
}

describe.skipIf(!enabled)('Live Eval（真模型）', () => {
  it(
    '跑完整份清单，报告写到 tests/evals/reports/',
    async () => {
      const manifest = loadCaseManifest(evalCasesPath())
      // 调试单条 case 用：EVAL_CASES=two-page-brief（逗号分隔多个 id），不过滤就是全量
      const onlyIds = (process.env['EVAL_CASES'] ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '')
      const cases =
        onlyIds.length === 0 ? manifest.cases : manifest.cases.filter((c) => onlyIds.includes(c.id))
      if (onlyIds.length > 0 && cases.length === 0) {
        throw new Error(`EVAL_CASES=${process.env['EVAL_CASES']} 没匹配到任何 case id`)
      }
      const workDir = makeEvalWorkDir('pa-eval-live-')
      const startedAt = new Date().toISOString()
      // pass^k / pass@k 口径：EVAL_RUNS=3 就是每条 case 跑 3 次（模型选型建议 ≥3）
      const runs = Math.max(1, Number.parseInt(process.env['EVAL_RUNS'] ?? '1', 10) || 1)
      try {
        const report = await runEval({
          mode: 'live',
          cases,
          manifestPath: evalCasesPath(),
          workDir,
          runtime: { command: VENV_PYTHON, args: ['-m', 'personal_agent'], cwd: RUNTIME_CWD },
          pricing: pricingFromEnv(),
          runs,
          // 失败 case 的轨迹落盘到 reports/，回看败在哪一步不用重跑
          traceDir: defaultReportDir(),
          onCase: (line) => console.log(line),
          // 每条 case 落一次部分报告：一场几十分钟，中途被杀（Ctrl-C / 断电 /
          // 进程崩）也能保住已跑完的部分——报告不应是"全有或全无"。
          onCaseResult: (results) => {
            const partial = buildReport({
              mode: 'live',
              model: process.env[LIVE_MODEL_ENV] ?? null,
              manifestPath: evalCasesPath(),
              startedAt,
              finishedAt: new Date().toISOString(),
              results,
              pricing: pricingFromEnv()
            })
            writeReport(partial, join(defaultReportDir(), 'live-partial.json'))
          }
        })

        const stamp = report.startedAt.replace(/[:.]/g, '-')
        const path = writeReport(report, join(defaultReportDir(), `live-${stamp}.json`))

        console.log(formatSummary(report))
        console.log(`报告: ${path}`)

        const parsed = EvalReportSchema.safeParse(report)
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
        expect(report.cases).toHaveLength(cases.length)
        expect(report.mode).toBe('live')
        // 真模型跑了，用量事件就该在：一个 token 都没记说明 model_usage 没落下来。
        expect(report.metrics.cost.inputTokens + report.metrics.cost.outputTokens).toBeGreaterThan(
          0
        )
      } finally {
        removeEvalWorkDir(workDir)
      }
    },
    // 25 条 × EVAL_RUNS 轮 × 真模型每轮几分钟：30 分钟的旧上限会在中途杀掉
    // 整场跑，报告一份都落不了盘。4 小时 + EVAL_TIMEOUT_MS 可覆盖。
    Math.max(
      30 * 60_000,
      Number.parseInt(process.env['EVAL_TIMEOUT_MS'] ?? '', 10) || 4 * 60 * 60_000
    )
  )
})
