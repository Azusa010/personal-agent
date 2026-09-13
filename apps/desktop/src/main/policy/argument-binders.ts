import {
  DocumentExtractPdfParams,
  ERROR_CODE,
  FilesystemListParams,
  type CapabilityId
} from '@personal-agent/protocol'

import { resolveWithinRootReal } from '../capabilities/path-guard'
import { resolveRoot } from '../capabilities/roots'

/** 契约校验 + 路径规范化之后的一次调用参数。
 *
 *  策略产出它，执行体只消费它。分开的理由在 SEC-005：TASK-018 要对**规范化后的
 *  参数**算 Canonical Arguments Hash，Permission 绑的是这个 hash。如果执行体自己
 *  再 parse 一次原始 arguments，「批准的东西」与「执行的东西」就有了第二次分叉的机会。
 */
export interface BoundArgs {
  /** 过了契约校验的参数，原样字段名。 */
  args: Record<string, unknown>
  /** 键与参数名一致，值是规范化后的绝对路径（realpath 解过链接、正斜杠）。 */
  paths: Record<string, string>
}

export type BindResult =
  { ok: true; bound: BoundArgs } | { ok: false; code: string; reason: string }

type Binder = (args: Record<string, unknown>) => Promise<BindResult>

function invalid(capability: string, message: string): BindResult {
  return {
    ok: false,
    code: ERROR_CODE.INVALID_ARGUMENT,
    reason: `${capability} 参数不符合契约: ${message}`
  }
}

// envelope 层的 arguments 是 z.record(z.string(), z.unknown())，什么都能过，
// 收窄只能在这里做。
const bindFilesystemList: Binder = async (args) => {
  const parsed = FilesystemListParams.safeParse(args)
  if (!parsed.success) return invalid('filesystem.list', parsed.error.message)
  // rootId 是白名单枚举里的一项，不是用户给的路径，所以不进 paths：
  // 授权根由 resolveRoot 从环境变量取，执行体自己会再取一次同一个值。
  return { ok: true, bound: { args: { rootId: parsed.data.rootId }, paths: {} } }
}

const bindExtractPdf: Binder = async (args) => {
  const parsed = DocumentExtractPdfParams.safeParse(args)
  if (!parsed.success) return invalid('document.extract_pdf', parsed.error.message)

  const root = resolveRoot('downloads')
  const guarded = await resolveWithinRootReal(root, parsed.data.path)
  if (!guarded.ok) {
    return { ok: false, code: guarded.code, reason: guarded.reason }
  }
  return {
    ok: true,
    bound: { args: { path: parsed.data.path }, paths: { path: guarded.path } }
  }
}

/** 每个能力的参数绑定器。没有登记的能力回 NOT_IMPLEMENTED：
 *  Scope 放行了却没有执行体，与「模型幻觉出一个不存在的工具」是两件事，
 *  后者在 CAPABILITY_NOT_REGISTERED 就被拦掉了。
 */
const BINDERS: Partial<Record<CapabilityId, Binder>> = {
  'filesystem.list': bindFilesystemList,
  'document.extract_pdf': bindExtractPdf
}

export async function bindArguments(
  capability: string,
  args: Record<string, unknown>
): Promise<BindResult> {
  const binder = BINDERS[capability as CapabilityId]
  if (binder === undefined) {
    return { ok: false, code: ERROR_CODE.NOT_IMPLEMENTED, reason: `执行体未实现: ${capability}` }
  }
  return binder(args)
}
