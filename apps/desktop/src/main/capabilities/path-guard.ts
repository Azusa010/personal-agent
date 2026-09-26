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

export const VIKING_URI_PREFIX = 'viking://'
export const WINDOWS_DEVICE_NAME_REGEX =
  /(^|[/\\])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.[^/\\]*)?([/\\]|$)/i

/**
 * 将 viking:// 虚拟 URI 安全解析并约束在 Viking 本地知识库根目录下。
 *
 * 契约与安全纵深防线：
 * 1. 协议头校验：必须以 viking:// 开头（忽略大小写），非 viking:// 协议直接拒绝抛出异常；
 * 2. 危险格式防御：
 *    - 拦截 UNC 与设备路径（如 //server/share 或 \\server\share）；
 *    - 拦截 Windows 绝对路径 / 盘符逃逸（如 C: 或 D:\）；
 *    - 拦截 Windows 保留设备文件名（CON, PRN, AUX, NUL, COM1-9, LPT1-9 等）；
 *    - 支持解开 URL 编码（如 %2e%2e/）；
 * 3. 边界防逃逸：利用 resolveWithinRoot 验证解析后的绝对路径严格落在 storeRoot 边界内；
 * 4. 返回值：标准化正斜杠形式的绝对文件路径。
 */
export function resolveVikingUriWithinRoot(uri: string, storeRoot: string): string {
  if (typeof uri !== 'string' || !uri.toLowerCase().startsWith(VIKING_URI_PREFIX)) {
    throw new Error(`INVALID_VIKING_URI: 必须以 viking:// 协议开头: ${uri}`)
  }
  let relPath = uri.slice(VIKING_URI_PREFIX.length)
  try {
    relPath = decodeURIComponent(relPath)
  } catch {
    throw new Error(`INVALID_VIKING_URI: URI 编码畸形: ${uri}`)
  }
  // 去除多余的起始斜杠
  const normalizedRel = relPath.replace(/^[/\\]+/, '')
  // 1. 拦截 UNC / 设备路径
  if (relPath.startsWith('//') || relPath.startsWith('\\\\')) {
    throw new Error(`VIKING_UNC_FORBIDDEN: 不接受 UNC 或网络共享路径: ${uri}`)
  }
  // 2. 拦截 Windows 绝对路径 / 盘符
  if (/^[a-zA-Z]:/i.test(normalizedRel) || /^[a-zA-Z]:/i.test(relPath)) {
    throw new Error(`VIKING_ABSOLUTE_PATH_FORBIDDEN: 禁止使用绝对盘符路径: ${uri}`)
  }
  // 3. 拦截 Windows 保留设备名
  if (WINDOWS_DEVICE_NAME_REGEX.test(relPath)) {
    throw new Error(`VIKING_DEVICE_NAME_FORBIDDEN: 禁止使用 Windows 保留设备名: ${uri}`)
  }
  // 4. 拦截非法控制字符
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f<>"|?*]/.test(relPath)) {
    throw new Error(`VIKING_INVALID_CHAR: 包含非法或控制字符: ${uri}`)
  }
  const base = toPosix(resolve(storeRoot))
  const candidate = toPosix(resolve(base, normalizedRel))
  if (resolveWithinRoot(base, candidate) === null) {
    throw new Error(`VIKING_SANDBOX_ESCAPE: 路径超出知识库根目录边界: ${uri}`)
  }
  return candidate
}
