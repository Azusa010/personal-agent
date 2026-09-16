import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * eval 这一层要用的仓库内路径：用例清单与报告目录。
 *
 * 不写死 `'../../../../..'`：层级被人挪动时写死的相对路径会静默指到别的地方，
 * 而按特征文件向上找根，找不到就直接抛错——错了看得见。main/e2e 的 E2E 也用
 * 这一份。
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('找不到仓库根（pnpm-workspace.yaml）')
    dir = parent
  }
}

/** FILE-021：20 条 Case 的清单，双端（人读 + 测试读）都是这一份 */
export function evalCasesPath(): string {
  return join(repoRoot(), 'tests', 'evals', 'cases.json')
}

/** 报告落盘目录。列进 .gitignore：报告是跑出来的产物，不是源码 */
export function defaultReportDir(): string {
  return join(repoRoot(), 'tests', 'evals', 'reports')
}
