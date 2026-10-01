import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { CodeInterpreterParams, ERROR_CODE } from '@personal-agent/protocol'

import { resolveRoot, toPosix } from '../roots'
import { truncateOutput } from '../output-truncator'
import type { CapabilityPlugin } from '../plugin'
import { describeError, fail, invalid } from './helpers'

export const codeInterpreterPlugin: CapabilityPlugin = {
  name: 'code_interpreter',
  descriptor: {
    name: 'code_interpreter',
    kind: 'WRITE',
    description:
      '在隔离沙盒内执行 Python 代码段。' +
      '用于复杂计算、批量数据转换及工具编排。\n\n' +
      '**重要**：遇到以下场景时，必须优先用代码而非纯文本推理：\n' +
      '- 数学计算（多步加减乘除、百分比、集合运算）→ 用 sympy 或直接 Python 计算\n' +
      '- 逻辑推理（排列组合、约束满足、真值表）→ 用 python-constraint 建模求解\n' +
      '- 数据统计（均值、方差、分布拟合）→ 用 numpy/scipy\n' +
      '- 符号代数（方程求解、微积分、矩阵运算）→ 用 sympy\n\n' +
      '代码推理比自然语言推理更精确、可验证、可复现。'
  },
  async bindArguments(args) {
    const parsed = CodeInterpreterParams.safeParse(args)
    if (!parsed.success) return invalid('code_interpreter', parsed.error.message)

    return {
      ok: true,
      bound: {
        args: parsed.data as Record<string, unknown>,
        paths: {}
      }
    }
  },
  async execute(call) {
    const code = String(call.bound.args['code'])
    const timeoutMs =
      typeof call.bound.args['timeoutMs'] === 'number' ? call.bound.args['timeoutMs'] : 30_000
    const saveArtifacts = Boolean(call.bound.args['saveArtifacts'] ?? false)

    const root = resolveRoot('downloads')
    const sandboxDir = join(root, '.scratch', `sandbox_${randomUUID().slice(0, 8)}`)
    await mkdir(sandboxDir, { recursive: true })

    const scriptPath = join(sandboxDir, 'script.py')
    await writeFile(scriptPath, code, 'utf8')

    // 优先选用 python，Windows 平台自动静默执行
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
    const command = `${pythonCmd} script.py`

    return new Promise((resolveResult) => {
      exec(
        command,
        {
          cwd: sandboxDir,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1'
          }
        },
        async (error, stdout, stderr) => {
          const outStr = String(stdout ?? '')
          const errStr = String(stderr ?? '')

          const scratchDir = join(root, '.scratch')
          const truncatedStdout = await truncateOutput(outStr, {
            scratchDir,
            prefix: 'py_stdout'
          })
          const truncatedStderr = await truncateOutput(errStr, {
            scratchDir,
            prefix: 'py_stderr'
          })

          const artifacts: string[] = []
          if (saveArtifacts) {
            try {
              const files = await readdir(sandboxDir)
              for (const f of files) {
                if (f !== 'script.py') {
                  artifacts.push(toPosix(relative(root, join(sandboxDir, f))))
                }
              }
            } catch {
              // ignore artifact read error
            }
          }

          if (error) {
            if (error.killed || error.signal === 'SIGTERM') {
              resolveResult(fail(ERROR_CODE.TERMINAL_TIMEOUT, `Python 执行超时 (${timeoutMs}ms)`))
              return
            }
            if (typeof error.code === 'number') {
              resolveResult({
                ok: true,
                exitCode: error.code,
                stdout: truncatedStdout.text,
                stderr: truncatedStderr.text,
                artifacts,
                truncated: truncatedStdout.truncated || truncatedStderr.truncated
              })
              return
            }
            resolveResult(
              fail(ERROR_CODE.TERMINAL_EXECUTE_FAILED, `Python 执行异常: ${describeError(error)}`)
            )
            return
          }

          resolveResult({
            ok: true,
            exitCode: 0,
            stdout: truncatedStdout.text,
            stderr: truncatedStderr.text,
            artifacts,
            truncated: truncatedStdout.truncated || truncatedStderr.truncated
          })
        }
      )
    })
  }
}
