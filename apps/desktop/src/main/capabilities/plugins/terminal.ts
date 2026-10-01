import { exec } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { ERROR_CODE, TerminalExecuteParams } from '@personal-agent/protocol'

import { resolveWithinRootReal } from '../path-guard'
import { resolveRoot, toPosix } from '../roots'
import { truncateOutput } from '../output-truncator'
import type { CapabilityPlugin } from '../plugin'
import { auditExpectedValues, describeError, fail, invalid, safeStat } from './helpers'

let currentTerminalCwd: string | null = null

export function getTerminalDefaultRoot(): string {
  if (process.env.PERSONAL_AGENT_WORKSPACE_DIR) {
    return resolveRoot('workspace')
  }
  if (process.env.PERSONAL_AGENT_DOWNLOADS_DIR) {
    return resolveRoot('downloads')
  }
  return resolveRoot('workspace')
}

export function getTerminalCwd(): string {
  return currentTerminalCwd ?? toPosix(getTerminalDefaultRoot())
}

export function resetTerminalCwd(): void {
  currentTerminalCwd = null
}

export const terminalExecutePlugin: CapabilityPlugin = {
  name: 'terminal_execute',
  descriptor: {
    name: 'terminal_execute',
    kind: 'WRITE',
    description: '在安全工作目录下执行终端命令行，支持会话级 cwd 记忆与 cd 状态保持'
  },
  async bindArguments(args) {
    const parsed = TerminalExecuteParams.safeParse(args)
    if (!parsed.success) return invalid('terminal_execute', parsed.error.message)

    const root = getTerminalDefaultRoot()
    const activeCwd = currentTerminalCwd ?? root
    const paths: Record<string, string> = {}

    if (parsed.data.cwd !== undefined) {
      const targetCwd = resolve(activeCwd, parsed.data.cwd)
      const guarded = await resolveWithinRootReal(root, targetCwd)
      if (!guarded.ok) {
        return { ok: false, code: guarded.code, reason: guarded.reason }
      }
      paths['cwd'] = guarded.path
    } else {
      paths['cwd'] = toPosix(activeCwd)
    }

    return {
      ok: true,
      bound: {
        args: {
          command: parsed.data.command,
          ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
          ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
          ...(parsed.data.expected_cwd_exists !== undefined
            ? { expected_cwd_exists: parsed.data.expected_cwd_exists }
            : {})
        },
        paths
      }
    }
  },
  async execute(call) {
    const command = String(call.bound.args['command'])
    const defaultRoot = getTerminalDefaultRoot()
    const activeCwd = call.bound.paths['cwd'] ?? defaultRoot

    const cwdStat = await safeStat(activeCwd)
    auditExpectedValues(
      call.callId,
      call.capability.name,
      { expected_cwd_exists: call.bound.args['expected_cwd_exists'] },
      { expected_cwd_exists: cwdStat?.isDirectory() ?? false }
    )

    // 拦截独立 cd 指令，会话级维持工作目录防回弹
    const cdMatch = command.trim().match(/^cd(?:\s+\/d)?(?:\s+(.+))?$/i)
    if (cdMatch) {
      const targetRaw = cdMatch[1]?.trim().replace(/^["']|["']$/g, '')
      // cd 无参数：在 Windows 下输出当前工作目录
      if (!targetRaw) {
        return {
          ok: true,
          exitCode: 0,
          stdout: `${activeCwd}\r\n`,
          stderr: ''
        }
      }

      const targetAbs = resolve(activeCwd, targetRaw)
      const guarded = await resolveWithinRootReal(defaultRoot, targetAbs)
      if (!guarded.ok) {
        return fail(guarded.code, `无法切换至受限范围外目录: ${guarded.reason}`)
      }

      let targetStat
      try {
        targetStat = await stat(guarded.path)
      } catch {
        return fail(ERROR_CODE.INVALID_ARGUMENT, `目录不存在: ${guarded.path}`)
      }

      if (!targetStat.isDirectory()) {
        return fail(ERROR_CODE.INVALID_ARGUMENT, `路径不是有效目录: ${guarded.path}`)
      }

      currentTerminalCwd = guarded.path
      return {
        ok: true,
        exitCode: 0,
        stdout: `[CWD 切换至]: ${guarded.path}\n`,
        stderr: ''
      }
    }

    const cwd = activeCwd
    const timeoutMs =
      typeof call.bound.args['timeoutMs'] === 'number' ? call.bound.args['timeoutMs'] : 30_000

    const isWin = process.platform === 'win32'
    return new Promise((resolveResult) => {
      exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          shell: isWin ? 'powershell.exe' : undefined
        },
        async (error, stdout, stderr) => {
          const outStr = String(stdout ?? '')
          const errStr = String(stderr ?? '')

          const scratchDir = resolve(defaultRoot, '.scratch')

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

          if (call.bound.paths['cwd']) {
            currentTerminalCwd = call.bound.paths['cwd']
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
