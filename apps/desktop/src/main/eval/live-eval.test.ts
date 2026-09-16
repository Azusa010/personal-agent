import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadCaseManifest } from './case-manifest'
import { pricingFromEnv } from './metrics'
import { defaultReportDir, evalCasesPath, repoRoot } from './paths'
import { EvalReportSchema, formatSummary, writeReport } from './report'
import { LIVE_MODEL_ENV, makeEvalWorkDir, removeEvalWorkDir, runEval } from './run-eval'

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
}

describe.skipIf(!enabled)('Live Eval（真模型）', () => {
  it(
    '跑完整份清单，报告写到 tests/evals/reports/',
    async () => {
      const manifest = loadCaseManifest(evalCasesPath())
      const workDir = makeEvalWorkDir('pa-eval-live-')
      try {
        const report = await runEval({
          mode: 'live',
          cases: manifest.cases,
          manifestPath: evalCasesPath(),
          workDir,
          runtime: { command: VENV_PYTHON, args: ['-m', 'personal_agent'], cwd: RUNTIME_CWD },
          pricing: pricingFromEnv(),
          onCase: (line) => console.log(line)
        })

        const stamp = report.startedAt.replace(/[:.]/g, '-')
        const path = writeReport(report, join(defaultReportDir(), `live-${stamp}.json`))

        console.log(formatSummary(report))
        console.log(`报告: ${path}`)

        const parsed = EvalReportSchema.safeParse(report)
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
        expect(report.cases).toHaveLength(manifest.cases.length)
        expect(report.mode).toBe('live')
        // 真模型跑了，用量事件就该在：一个 token 都没记说明 model_usage 没落下来。
        expect(report.metrics.cost.inputTokens + report.metrics.cost.outputTokens).toBeGreaterThan(
          0
        )
      } finally {
        removeEvalWorkDir(workDir)
      }
    },
    30 * 60_000
  )
})
