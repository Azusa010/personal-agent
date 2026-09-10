import { resolve } from 'path'
import { toPosix } from './roots'

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
