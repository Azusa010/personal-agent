/**
 * binder.ts 替代 tools 插件的 bindArgument 方法
 * 实现 检验工厂
 * */
import { z } from 'zod'
import { invalid } from './plugins/helpers'
import { BindResult } from '../policy/argument-binders'
import { resolveRoot } from './roots'
import { resolvePathReal } from './path-guard'
import path from 'node:path'

export interface PathRule {
  field: string // 字段名
  optional?: boolean
  destKey?: string
}

/** 相对路径的解析基准：工作区根。它不是安全边界——读全盘自由，写走批准卡片；
 * 在这里只负责「模型说 report.pdf 时找到的是哪个目录」。 */
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
      const base = resolveRoot('workspace')
      for (const rule of pathRules) {
        const fieldValue = parsed.data[rule.field]
        if (fieldValue === undefined || fieldValue === null || typeof fieldValue !== 'string') {
          if (rule.optional) continue
          return invalid(capabilityName, `Field ${rule.field} is required but missing or null`)
        }
        const candidate = path.isAbsolute(fieldValue)
          ? fieldValue
          : path.resolve(base, fieldValue)
        const guarded = await resolvePathReal(candidate)
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
