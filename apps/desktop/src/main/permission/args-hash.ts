import { createHash } from 'node:crypto'

import type { BoundArgs } from '../policy/argument-binders'
import { canonicalize } from './canonical-json'

/** 参数的指纹，用于权限判断 */
export interface ArgumentFingerprint {
  /** 落进 permissions.args_canonical */
  readonly canonical: string
  /** 落进 permissions.args_hash */
  readonly hash: string
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 参与哈希的有效参数：args 提供非路径字段，paths 用规范化值覆盖同名的路径字段。
 *
 *  覆盖顺序不能反。`bound.args.path` 是模型给的原始写法（`D:\downloads\a.pdf`），
 *  `bound.paths.path` 是 realpath 解过链接的正斜杠形式。执行体读的是后者，
 */
export function effectiveArgs(bound: BoundArgs): Record<string, unknown> {
  return { ...bound.args, ...bound.paths }
}

/** 只覆盖参数，不把 capability 与 taskId 混进来：两者都是 permissions 表里独立的列，
 */
export function fingerprintArguments(bound: BoundArgs): ArgumentFingerprint {
  const canonical = canonicalize(effectiveArgs(bound))
  return { canonical, hash: sha256Hex(canonical) }
}
