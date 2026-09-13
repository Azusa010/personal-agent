import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { toPosix } from './roots'

// 一个路径 resolve 之后是否在给定根内
export function resolveWithinRoot(root: string, candidate: string): string | null {
  const base = toPosix(resolve(root))
  const abs = toPosix(resolve(candidate))
  const lowerBase = base.toLowerCase()
  const lowerAbs = abs.toLowerCase()

  if (lowerAbs !== lowerBase && !lowerAbs.startsWith(lowerBase + '/')) {
    return null
  }
  return abs
}

export type PathGuardCode =
  'PATH_OUT_OF_ROOT' | 'PATH_ESCAPES_ROOT_VIA_LINK' | 'PATH_UNC_NOT_ALLOWED'

export type PathGuardResult =
  { ok: true; path: string } | { ok: false; code: PathGuardCode; reason: string }

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 把一个绝对路径拆成「最近的存在祖先」+「剩余不存在的段」。
 * 例子（Windows，正斜杠形式）：
 * - 'D:/root/a.pdf'，a.pdf 存在 → { existing: 'D:/root/a.pdf', rest: [] }
 * - 'D:/root/a.pdf'，a.pdf 不存在但 root 存在 → { existing: 'D:/root', rest: ['a.pdf'] }
 * - 'D:/' 本身就不存在（盘符不在）→ { existing: 'D:/', rest: ['root', 'a.pdf'] }
 *
 * 入参 abs：已经 resolve + toPosix 过的绝对路径，所以一定形如 'D:/x/y'，
 * 第一个 '/' 之前就是盘符。不会拿到 UNC（'//server/...'），
 * 那种在进这里之前就被拒了。
 */
export async function splitExisting(abs: string): Promise<{ existing: string; rest: string[] }> {
  const posix = toPosix(resolve(abs))
  const drive = posix.slice(0, posix.indexOf('/') + 1)
  const segments = posix
    .slice(drive.length)
    .split('/')
    .filter((s) => s !== '')

  for (let i = segments.length; i > 0; i--) {
    const head = drive + segments.slice(0, i).join('/')
    if (await exists(head)) {
      return { existing: head, rest: segments.slice(i) }
    }
  }
  return { existing: drive, rest: segments }
}

/** 词法检查之外再加一层：把 junction / symlink 解开之后再判一次
 *
 * resolveWithinRoot 只做字符串运算，'D:/root/link.pdf' 这种「根内的链接
 * 指向根外的文件」它一律放行。这里把两边都换成真实路径再比一次。
 *
 * 入参：
 * - root：resolveRoot('downloads') 的返回值，已经是正斜杠绝对路径。
 * - candidate：模型给的 path 参数原样，不可信（SEC-006）。
 */
export async function resolveWithinRootReal(
  root: string,
  candidate: string
): Promise<PathGuardResult> {
  const base = toPosix(resolve(root))
  const abs = toPosix(resolve(candidate))

  if (base.startsWith('//') || abs.startsWith('//')) {
    return {
      ok: false,
      code: 'PATH_UNC_NOT_ALLOWED',
      reason: `不接受 UNC 或设备路径: ${candidate}`
    }
  }

  // base 不在根内
  if (resolveWithinRoot(base, abs) === null) {
    return {
      ok: false,
      code: 'PATH_OUT_OF_ROOT',
      reason: `路径不在授权根 ${base} 内: ${candidate}`
    }
  }

  // 根自己可能就是 junction，不先解开的话下面拿一个假根去比。
  let realRoot: string
  try {
    realRoot = toPosix(await realpath(base))
  } catch {
    // 根都不可用，就没有任何东西能在它里面。判不出来就是拒。
    return { ok: false, code: 'PATH_OUT_OF_ROOT', reason: `授权根不可用: ${base}` }
  }

  // 目标还没被创建时 realpath 会 ENOENT，而「不存在」不等于「越界」——
  // 那该由下游 readFile 报 FILE_UNREADABLE。所以只对最近存在的祖先做 realpath。
  const { existing, rest } = await splitExisting(abs)
  let realExisting: string
  try {
    realExisting = toPosix(await realpath(existing))
  } catch {
    return { ok: false, code: 'PATH_OUT_OF_ROOT', reason: `路径不可解析: ${candidate}` }
  }
  const stem = realExisting.endsWith('/') ? realExisting.slice(0, -1) : realExisting
  const real = rest.length === 0 ? realExisting : `${stem}/${rest.join('/')}`

  if (resolveWithinRoot(realRoot, real) === null) {
    return {
      ok: false,
      code: 'PATH_ESCAPES_ROOT_VIA_LINK',
      reason: `路径经链接指向授权根 ${realRoot} 之外: ${candidate}`
    }
  }
  // 回真实路径：下游直接喂 readFile，不要再 resolve 一次，
  // 否则日志里的路径与实际读的不是同一个字符串。
  return { ok: true, path: real }
}
