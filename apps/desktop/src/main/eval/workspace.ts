import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildPdf } from '../capabilities/pdf-fixtures'
import { toPosix } from '../capabilities/roots'
import { targetPdf, type EvalCase } from './case-manifest'

/**
 * 把一条 case 落成一次任务的授权根。
 *
 * 每次跑都现场生成 PDF：
 * 页面文本在清单里，PDF 从清单生成，于是「清单说第 3 页有 12% 增长」与
 * 「第 3 页真的写着 12% 增长」是同一份事实，不会各自漂移。
 */

/** 同一 case 内相邻两份文件的落盘时间差。「最近改过的那份」因此有确定答案 */
export const MTIME_STEP_MS = 60_000
/** 固定基准时刻：不取 Date.now()，同一份清单每次跑出来的 mtime 完全一样 */
export const MTIME_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)

export interface MaterializedFile {
  name: string
  /** 绝对路径（正斜杠），与 filesystem_list 回传的 absolutePath 同一种写法 */
  path: string
  modifiedAtMs: number
}

export interface MaterializedCase {
  id: string
  /** 这次任务的授权根（Downloads）。跑完由调用方决定留不留 */
  dir: string
  /** 期望被提取的那份 PDF 的绝对路径 */
  targetPath: string
  /** 按清单顺序写入的文件：每份比前一份晚 MTIME_STEP_MS 落盘 */
  files: MaterializedFile[]
}

export function materializeCase(dir: string, evalCase: EvalCase): MaterializedCase {
  mkdirSync(dir, { recursive: true })
  const files: MaterializedFile[] = []
  let index = 0

  const write = (name: string, data: string | Uint8Array): void => {
    const path = join(dir, name)
    writeFileSync(path, data)
    const mtimeSeconds = (MTIME_BASE_MS + index * MTIME_STEP_MS) / 1000
    utimesSync(path, mtimeSeconds, mtimeSeconds)
    files.push({ name, path: toPosix(path), modifiedAtMs: MTIME_BASE_MS + index * MTIME_STEP_MS })
    index += 1
  }

  for (const pdf of evalCase.pdfs) write(pdf.name, buildPdf(pdf.pages))
  for (const extra of evalCase.extraFiles) write(extra.name, extra.content)

  const targetName = targetPdf(evalCase).name
  const target = files.find((f) => f.name === targetName)
  if (target === undefined) {
    throw new Error(`case ${evalCase.id} 的目标 PDF 没写进目录: ${targetName}`)
  }

  return { id: evalCase.id, dir: toPosix(dir), targetPath: target.path, files }
}
