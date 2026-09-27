import { exec } from 'node:child_process'
import { resolve } from 'node:path'

import { ERROR_CODE, TerminalExecuteParams } from '@personal-agent/protocol'

import { resolveWithinRootReal } from '../path-guard'
import { resolveRoot, toPosix } from '../roots'
import { truncateOutput } from '../output-truncator'
import type { CapabilityPlugin } from '../plugin'
import { describeError, fail, invalid } from './helpers'

export const terminalExecutePlugin: CapabilityPlugin = {
  name: 'terminal_execute',
  descriptor: {
    name: 'terminal_execute',
    kind: 'WRITE',
    description: '在安全工作目录下执行终端命令行'
  },
  async bindArguments(args) {
    const parsed = TerminalExecuteParams.safeParse(args)
    if (!parsed.success) return invalid('terminal_execute', parsed.error.message)

    const root = resolveRoot('downloads')
    const paths: Record<string, string> = {}

    if (parsed.data.cwd !== undefined) {
      const targetCwd = resolve(root, parsed.data.cwd)
      const guarded = await resolveWithinRootReal(root, targetCwd)
      if (!guarded.ok) {
        return { ok: false, code: guarded.code, reason: guarded.reason }
      }
      paths['cwd'] = guarded.path
    } else {
      paths['cwd'] = toPosix(root)
    }

    return {
      ok: true,
      bound: {
        args: {
          command: parsed.data.command,
          ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
          ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {})
        },
        paths
      }
    }
  },
  async execute(call) {
    const command = String(call.bound.args['command'])
    const cwd = call.bound.paths['cwd'] ?? resolveRoot('downloads')
    const timeoutMs =
      typeof call.bound.args['timeoutMs'] === 'number' ? call.bound.args['timeoutMs'] : 30_000

    return new Promise((resolveResult) => {
      exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        },
        async (error, stdout, stderr) => {
          const outStr = String(stdout ?? '')
          const errStr = String(stderr ?? '')

          const root = resolveRoot('downloads')
          const scratchDir = resolve(root, '.scratch')

          const truncatedStdout = await truncateOutput(outStr, {
            scratchDir,
            prefix: 'term_stdout'
          })
          const truncatedStderr = await truncateOutput(errStr, {
            scratchDir,
            prefix: 'term_stderr'
          })

          if (error) {
            if (error.killed || error.signal === 'SIGTERM') {
              resolveResult(fail(ERROR_CODE.TERMINAL_TIMEOUT, `命令执行超时 (${timeoutMs}ms)`))
              return
            }
            if (typeof error.code === 'number') {
              resolveResult({
                ok: true,
                exitCode: error.code,
                stdout: truncatedStdout.text,
                stderr: truncatedStderr.text
              })
              return
            }
            resolveResult(
              fail(ERROR_CODE.TERMINAL_EXECUTE_FAILED, `命令执行异常: ${describeError(error)}`)
            )
            return
          }

          resolveResult({
            ok: true,
            exitCode: 0,
            stdout: truncatedStdout.text,
            stderr: truncatedStderr.text
          })
        }
      )
    })
  }
}
