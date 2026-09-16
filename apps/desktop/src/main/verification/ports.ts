import { readFile, stat } from 'node:fs/promises'

import { extractPdf } from '../capabilities/document-extract-pdf'
import { resolveWithinRootReal } from '../capabilities/path-guard'
import { resolveRoot } from '../capabilities/roots'
import type { PageNumbersRead, VerificationPorts } from './evidence-bundle'

/**
 * VerificationPorts 的生产实现。
 *
 * 三个端口都贴着「可信侧的真实状态」：
 *   - 路径解析走与执行体同一条 path-guard，越界与链接逃逸在这里再判一次；
 *   - 页号是**重新读一遍真实 PDF** 得到的，不是 Python 回传的页数。
 *     取证要独立于被取证方的自述，否则页码上下限校验只是把同一个数抄第二遍。
 *   - 存在性是真实文件系统检查。
 *
 * 与 executor 侧的分工：executor 用 realpath 后的绝对路径干活，
 * 这里用 resolveWithinRootReal 把「事件里的原始路径」重新规范化，两边同一套规则。
 * 差异只在目的：那边是执行前的把关，这边是执行后的复核。
 *
 * 失败留痕：三个端口的失败各打一条 console.warn，正常路径一次都不打。
 *
 * 日志只到主进程控制台，**不进 ExecutionEvent、也不进 Evidence Bundle**——
 * 那两样会到 Renderer（SEC-006/008），失败明细（路径、errno）不该出现在那里。
 * 判定表读到的是 gaps 里那句人话，排查的人靠这条日志拿到更细的现场：
 * 是路径被拒（越界 / 根不可用）、还是文件读不出来（ENOENT / EPERM）。
 */
export const realVerificationPorts: VerificationPorts = {
  async resolvePath(rawPath: string): Promise<string | null> {
    const guarded = await resolveWithinRootReal(resolveRoot('downloads'), rawPath)
    if (!guarded.ok) {
      logFailure('resolvePath', `${guarded.code}: ${guarded.reason} (${rawPath})`)
      return null
    }
    return guarded.path
  },

  async readPageNumbers(absPath: string): Promise<PageNumbersRead> {
    let raw: Buffer
    try {
      raw = await readFile(absPath)
    } catch (e) {
      const reason = `读取失败 (${describe(e)})`
      logFailure('readPageNumbers', `${reason} (${absPath})`)
      return { ok: false, reason }
    }
    try {
      const extracted = await extractPdf(raw)
      if (!extracted.ok) {
        logFailure('readPageNumbers', `${extracted.code} (${absPath}): ${extracted.reason}`)
        return { ok: false, reason: `${extracted.code}: ${extracted.reason}` }
      }
      return { ok: true, pageNumbers: extracted.pages.map((p) => p.pageNumber) }
    } catch (e) {
      // extractPdf 契约上把已知的 PDF 问题收进结果，这里兜底的是意外抛错。
      const reason = `PDF 解析异常 (${describe(e)})`
      logFailure('readPageNumbers', `${reason} (${absPath})`)
      return { ok: false, reason }
    }
  },

  async pathExists(absPath: string): Promise<boolean> {
    try {
      await stat(absPath)
      return true
    } catch (e) {
      // 只有「不存在」算 false。权限错、盘符掉线这类必须抛出去——
      // 把它们说成「文件不在」，判定表就会用一条假事实做结论。
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      logFailure('pathExists', `${describe(e)} (${absPath})`)
      throw e
    }
  }
}

/** 端口的失败留痕。级别用 warn：不该打断启动，也不该被当成错误噪音刷屏。 */
function logFailure(port: string, detail: string): void {
  console.warn(`[verification] ${port} 失败: ${detail}`)
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
