import { execFile, type ExecFileException } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { findProbe, type LanguageProbe } from './diagnostic-registry'

export type ExecFileLike = typeof execFile

export interface DiagnosticProbeOptions {
  /** 可选注入的 execFile 实现（方便单元测试 Mock） */
  readonly execFileFn?: ExecFileLike
  /** CLI 执行超时硬上限（毫秒，默认 1500ms） */
  readonly timeoutMs?: number
}

export interface DiagnosticProbeResult {
  readonly diagnostics: string[]
}

const DEFAULT_TIMEOUT_MS = 1500

/**
 * Tier 0: 原生纯内存快速语法校验 (< 5ms)
 *
 * # Contract:
 *   - Input: probe (语言探针), content (文件内容), absFilePath (文件绝对路径)
 *   - Output: 语法错误描述数组；若无错误或未提供 fastSyntaxCheck 返回 null
 *   - Test: tests/main/capabilities/diagnostic-probe.test.ts ("Tier 0")
 */
export function runTier0FastCheck(
  probe: LanguageProbe,
  content: string,
  absFilePath: string
): string[] | null {
  if (probe.fastSyntaxCheck) {
    const issues = probe.fastSyntaxCheck(content, absFilePath)
    if (issues && issues.length > 0) {
      return issues
    }
  }
  return null
}

/**
 * Tier 1: CLI 单文件探针执行器 (带 1500ms 超时与 Fail-Open 降级)
 *
 * # Contract:
 *   - Input: probe (语言探针), workspaceRoot (工作区根), absFilePath (文件路径), options
 *   - Output: 提取后的紧凑诊断数组；异常或未安装时一律静默返回 []
 *   - Boundary: 绝对不上浮抛错，ENOENT/超时/崩溃均返回 []
 *   - Test: tests/main/capabilities/diagnostic-probe.test.ts ("Tier 1", "边界与异常")
 */
export async function runTier1CliProbe(
  probe: LanguageProbe,
  workspaceRoot: string,
  absFilePath: string,
  options?: DiagnosticProbeOptions
): Promise<string[]> {
  if (!probe.cli) return []

  const exec = options?.execFileFn ?? execFile
  const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { command, buildArgs, parseOutput } = probe.cli
  const args = buildArgs(absFilePath, workspaceRoot)

  return new Promise<string[]>((resolve) => {
    try {
      exec(
        command,
        args,
        {
          cwd: workspaceRoot,
          timeout,
          windowsHide: true
        },
        (error: ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            if (error.code === 'ENOENT') {
              // 1. CLI 未安装，静默放行
              resolve([])
            } else if (error.killed || error.signal === 'SIGTERM') {
              // 2. CLI 执行超时，静默熔断
              resolve([])
            } else {
              // 3. CLI 发现错误并以非 0 退出（依然有 stdout/stderr 输出）
              const exitCode = typeof error.code === 'number' ? error.code : 1
              resolve(parseOutput(stdout || '', stderr || '', exitCode))
            }
          } else {
            // 4. CLI 执行成功
            resolve(parseOutput(stdout || '', stderr || '', 0))
          }
        }
      )
    } catch {
      // 外部同步调用异常兜底（如函数抛错）
      resolve([])
    }
  })
}

/**
 * 文件写/改后即时诊断探针总入口 (Dual-Stage: Tier 0 快速 + Tier 1 CLI)
 *
 * # Contract:
 *   - 无论发生何种异常，保证 Fail-Open（故障开放），绝不中断上层写盘事务
 */
export async function runDiagnosticProbe(
  workspaceRoot: string,
  absFilePath: string,
  content?: string,
  options?: DiagnosticProbeOptions
): Promise<DiagnosticProbeResult> {
  try {
    const probe = findProbe(absFilePath)
    if (!probe) {
      return { diagnostics: [] }
    }

    // 1. 若未传入 content，异步读取文件内容以供校验
    let text = content
    if (text === undefined) {
      try {
        text = await readFile(absFilePath, 'utf8')
      } catch {
        return { diagnostics: [] }
      }
    }

    // 2. Tier 0: 原生零开销快速语法校验 (< 5ms)
    const tier0Issues = runTier0FastCheck(probe, text, absFilePath)
    if (tier0Issues && tier0Issues.length > 0) {
      return { diagnostics: tier0Issues }
    }

    // 3. Tier 1: CLI 单文件增量扫描 (带超时与静默降级)
    const tier1Issues = await runTier1CliProbe(probe, workspaceRoot, absFilePath, options)
    return { diagnostics: tier1Issues }
  } catch {
    // 终极安全兜底：探针异常绝不上浮
    return { diagnostics: [] }
  }
}
