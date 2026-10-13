/**
 * binder.ts 替代 tools 插件的 bindArgument 方法
 * 实现 检验工厂
 * */
import { z } from 'zod'
import { invalid } from './plugins/helpers'
import { BindResult } from '../policy/argument-binders'
import { resolveRoot } from './roots'
import path from 'node:path'
import { resolveWithinRootReal } from './path-guard'

export interface PathRule {
  field: string // 字段名
  root: string | ((args: Record<string, unknown>) => string)
  optional?: boolean
  destKey?: string
}

export function defineBinder<T extends Record<string, unknown>>(
  capabilityName: string,
  schema: z.ZodSchema<T>,
  pathRules?: PathRule[]
): (args: Record<string, unknown>) => Promise<BindResult> {
  return async (args: Record<string, unknown>): Promise<BindResult> => {
    const parsed = schema.safeParse(args)
    if (!parsed.success) {
      return invalid(capabilityName, parsed.error.message)
    }
    const paths: Record<string, string> = {}
    if (pathRules) {
      for (const rule of pathRules) {
        const fieldValue = parsed.data[rule.field]
        if (fieldValue === undefined || fieldValue === null || typeof fieldValue !== 'string') {
          if (rule.optional) continue
          return invalid(capabilityName, `Field ${rule.field} is required but missing or null`)
        }
        const rootId =
          rule.root && typeof rule.root === 'function'
            ? rule.root(parsed.data as Record<string, unknown>)
            : rule.root
        const resolvedRoot = resolveRoot(rootId)
        const candidate = path.isAbsolute(fieldValue)
          ? fieldValue
          : path.resolve(resolvedRoot, fieldValue)
        const guarded = await resolveWithinRootReal(resolvedRoot, candidate)
        if (!guarded.ok) {
          return {
            ok: false,
            code: guarded.code,
            reason: `${guarded.reason}（${capabilityName} 的 ${String(rule.field)} 参数）`
          }
        }
        paths[rule.destKey ?? rule.field] = guarded.path
      }
    }
    return {
      ok: true,
      bound: { args: parsed.data as Record<string, unknown>, paths }
    }
  }
}
