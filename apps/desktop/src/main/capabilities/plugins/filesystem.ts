import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  ERROR_CODE,
  FilesystemCreateDirParams,
  type FilesystemCreateDirOutcome,
  FilesystemListParams,
  type FilesystemMoveOutcome,
  FilesystemMoveParams,
  type PdfEntry
} from '@personal-agent/protocol'

import { formatModifiedAt, resolveRoot, toPosix } from '../roots'
import { defineBinder } from '../binder'
import type { RecoveryVerdict } from '../idempotency'
import type { ToolExecutionRecord } from '../../product-state/tool-execution-repository'
import type { CapabilityPlugin } from '../plugin'
import { auditExpectedValues, describeError, fail, safeStat } from './helpers'

// ==========================================
// 1. Filesystem List 纯业务执行体与助手函数
// ==========================================

export interface ListDirectoryOptions {
  readonly pattern?: string
}

function matchesPattern(name: string, pattern?: string): boolean {
  if (!pattern || pattern.trim() === '') return true
  const lowerName = name.toLowerCase()
  const lowerPattern = pattern.trim().toLowerCase()
  if (lowerPattern.startsWith('*.')) {
    return lowerName.endsWith(lowerPattern.slice(1))
  }
  if (lowerPattern.includes('*')) {
    const escaped = lowerPattern.replace(/\./g, '\\.').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`, 'i').test(name)
  }
  return lowerName.includes(lowerPattern)
}

/**
 * 列出授权根目录下的条目（文件与子目录）。
 * 支持可选的通配符/后缀/关键词过滤 pattern（如 `*.pdf`），返回包含 type 的结构化条目。
 */
export async function listDirectory(
  base: string,
  options?: ListDirectoryOptions
): Promise<PdfEntry[]> {
  const names = await readdir(base)
  const scored: { mtimeMs: number; entry: PdfEntry }[] = []

  for (const name of names) {
    if (!matchesPattern(name, options?.pattern)) continue
    const full = join(base, name)
    try {
      const s = await stat(full)
      const entryType: 'file' | 'directory' = s.isDirectory() ? 'directory' : 'file'
      scored.push({
        mtimeMs: s.mtimeMs,
        entry: {
          name,
          absolutePath: toPosix(resolve(full)),
          modifiedAt: formatModifiedAt(s.mtimeMs),
          sizeBytes: s.size,
          type: entryType
        }
      })
    } catch {
      continue
    }
  }
  scored.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return scored.map((s) => s.entry)
}

/** 保留历史函数以完全兼容既有单元测试与依赖项。 */
export async function listPdfs(base: string): Promise<PdfEntry[]> {
  const all = await listDirectory(base, { pattern: '*.pdf' })
  return all.filter((e) => e.type === 'file')
}

// ==========================================
// 2. Filesystem Create Dir 纯业务执行体
// ==========================================

function failCreateDir(reason: string): FilesystemCreateDirOutcome {
  return { ok: false, code: ERROR_CODE.CREATE_DIR_FAILED, reason }
}

async function safeStatPath(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * 在指定绝对路径创建目录。
 * 遵循“执行-验证-反馈”闭环：完成 mkdir 后立即执行二次 stat 校验，确保文件系统落盘生效。
 */
export async function createDir(absPath: string): Promise<FilesystemCreateDirOutcome> {
  const stats = await safeStatPath(absPath)

  if (!stats) {
    try {
      await mkdir(absPath, { recursive: true })
      // 执行-验证-反馈闭环：核验新创建目录确实存在且为目录
      const verified = await safeStatPath(absPath)
      if (!verified || !verified.isDirectory()) {
        return failCreateDir(`目录创建后验证失败，未找到目标目录: ${absPath}`)
      }
    } catch (error) {
      return failCreateDir(error instanceof Error ? error.message : String(error))
    }
    return { ok: true, path: absPath, created: true }
  }
  if (stats.isDirectory()) {
    return { ok: true, path: absPath, created: false }
  }
  return failCreateDir(`${absPath} exists but not a directory`)
}

// ==========================================
// 3. Filesystem Move 纯业务执行体
// ==========================================

function failMove(code: string, reason: string): FilesystemMoveOutcome {
  return { ok: false, code, reason }
}

/**
 * 在授权根目录内移动文件。
 * - 负向约束：目标已存在时绝不静默覆盖，抛出 MOVE_TARGET_EXISTS；
 * - 健壮性保障：捕获跨卷 EXDEV 异常并无缝 fallback 到 copy + unlink；
 * - 执行-验证-反馈闭环：移动后校验目标存在且字节大小一致，确保副作用彻底发生。
 */
export async function moveFile(source: string, target: string): Promise<FilesystemMoveOutcome> {
  const sourceStat = await safeStatPath(source)
  if (!sourceStat) {
    return failMove(ERROR_CODE.MOVE_SOURCE_MISSING, `source missing: ${source}`)
  }
  const targetStat = await safeStatPath(target)
  if (targetStat) {
    return failMove(ERROR_CODE.MOVE_TARGET_EXISTS, `target exists: ${target}`)
  }
  try {
    await rename(source, target)
  } catch (e: unknown) {
    const errno = e as NodeJS.ErrnoException
    if (errno.code === 'EXDEV') {
      try {
        await copyFile(source, target)
        await unlink(source)
      } catch (copyErr) {
        return failMove(ERROR_CODE.MOVE_FAILED, `跨卷复制移动失败: ${copyErr}`)
      }
    } else {
      return failMove(ERROR_CODE.MOVE_FAILED, `move failed: ${e}`)
    }
  }

  // 执行-验证-反馈闭环：核验目标存在且大小与原文件一致，源文件已不在
  const verifiedTarget = await safeStatPath(target)
  const verifiedSource = await safeStatPath(source)
  if (!verifiedTarget || verifiedTarget.size !== sourceStat.size || verifiedSource !== undefined) {
    return failMove(ERROR_CODE.MOVE_FAILED, `文件移动后状态校验异常: 目标未正确就位或源文件残留`)
  }

  return { ok: true, source, target }
}

// ==========================================
// 4. 自描述插件声明 (CapabilityPlugin)
// ==========================================

export const filesystemListPlugin: CapabilityPlugin = {
  name: 'filesystem_list',
  descriptor: {
    name: 'filesystem_list',
    kind: 'READ',
    description: '列出授权根目录下的条目'
  },
  bindArguments: defineBinder('filesystem_list', FilesystemListParams, [
    { field: 'path', root: (args) => String(args.rootId), destKey: 'targetDir', optional: true }
  ]),
  async execute(call) {
    const rootId = String(call.bound.args['rootId'])
    const targetDir = call.bound.paths['targetDir'] ?? resolveRoot(rootId)
    const pattern =
      typeof call.bound.args['pattern'] === 'string' ? call.bound.args['pattern'] : undefined
    try {
      const entries = await listDirectory(targetDir, { pattern })
      return { ok: true, entries }
    } catch (e) {
      return fail(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE, `授权根不可用 (${describeError(e)})`)
    }
  }
}

export const filesystemCreateDirPlugin: CapabilityPlugin = {
  name: 'filesystem_create_dir',
  descriptor: {
    name: 'filesystem_create_dir',
    kind: 'WRITE',
    description: '在授权根目录下创建子目录'
  },
  bindArguments: defineBinder('filesystem_create_dir', FilesystemCreateDirParams, [
    { field: 'path', root: 'workspace' }
  ]),
  extractPermissionPaths(bound) {
    return { sourcePaths: [], targetPath: bound.paths['path'] ?? null }
  },
  idempotency: {
    isWrite: true,
    extractSideEffects(bound) {
      return { sourcePaths: [], targetPath: bound.paths['path'] ?? null }
    },
    async resolveRecovery(record: ToolExecutionRecord): Promise<RecoveryVerdict> {
      if (record.targetPath === null) {
        return { kind: 'unknown', reason: '数据异常：targetPath 为 null' }
      }
      const targetStats = await safeStat(record.targetPath)
      if (targetStats && targetStats.isDirectory()) {
        return { kind: 'done' }
      }
      if (targetStats && !targetStats.isDirectory()) {
        return { kind: 'unknown', reason: '目标路径存在但不是目录' }
      }
      return { kind: 'not-done' }
    }
  },
  async execute(call) {
    const abs = call.bound.paths['path']
    const parentStat = await safeStat(dirname(abs))
    auditExpectedValues(
      call.callId,
      call.capability.name,
      { expected_parent_exists: call.bound.args['expected_parent_exists'] },
      { expected_parent_exists: parentStat?.isDirectory() ?? false }
    )
    try {
      return await createDir(abs)
    } catch (e) {
      return fail(ERROR_CODE.CREATE_DIR_FAILED, `创建目录失败 (${describeError(e)}): ${abs}`)
    }
  }
}

export const filesystemMovePlugin: CapabilityPlugin = {
  name: 'filesystem_move',
  descriptor: {
    name: 'filesystem_move',
    kind: 'WRITE',
    description: '在授权根目录内移动文件'
  },
  bindArguments: defineBinder('filesystem_move', FilesystemMoveParams, [
    { field: 'source', root: 'workspace' },
    { field: 'target', root: 'workspace' }
  ]),
  extractPermissionPaths(bound) {
    return {
      sourcePaths: bound.paths['source'] !== undefined ? [bound.paths['source']] : [],
      targetPath: bound.paths['target'] ?? null
    }
  },
  idempotency: {
    isWrite: true,
    extractSideEffects(bound) {
      return {
        sourcePaths: bound.paths['source'] !== undefined ? [bound.paths['source']] : [],
        targetPath: bound.paths['target'] ?? null
      }
    },
    async resolveRecovery(record: ToolExecutionRecord): Promise<RecoveryVerdict> {
      if (record.sourcePaths.length === 0 || record.targetPath === null) {
        return { kind: 'unknown', reason: '数据异常：sourcePaths 为空或 targetPath 为 null' }
      }
      const sourceStats = await safeStat(record.sourcePaths[0])
      const targetStats = await safeStat(record.targetPath)
      if (!sourceStats && targetStats) {
        return { kind: 'done' }
      }
      if (!sourceStats && !targetStats) {
        return { kind: 'unknown', reason: '源路径和目标路径都不存在' }
      }
      if (sourceStats && targetStats) {
        return { kind: 'unknown', reason: '源路径和目标路径同时存在' }
      }
      return { kind: 'not-done' }
    }
  },
  async execute(call) {
    const source = call.bound.paths['source']
    const target = call.bound.paths['target']
    const sourceStat = await safeStat(source)
    const targetDirStat = await safeStat(dirname(target))
    auditExpectedValues(
      call.callId,
      call.capability.name,
      {
        expected_source_exists: call.bound.args['expected_source_exists'],
        expected_source_is_file: call.bound.args['expected_source_is_file'],
        expected_target_dir_exists: call.bound.args['expected_target_dir_exists']
      },
      {
        expected_source_exists: sourceStat !== undefined,
        expected_source_is_file: sourceStat?.isFile() ?? false,
        expected_target_dir_exists: targetDirStat?.isDirectory() ?? false
      }
    )
    try {
      return await moveFile(source, target)
    } catch (e) {
      return fail(ERROR_CODE.MOVE_FAILED, `移动失败 (${describeError(e)}): ${source} -> ${target}`)
    }
  }
}
