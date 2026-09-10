import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const ROOT_ENV: Record<string, string> = {
  downloads: 'PERSONAL_AGENT_DOWNLOADS_DIR'
}

// 反斜杠 -> 正斜杠
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

// 格式化修改时间
export function formatModifiedAt(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function resolveRoot(rootId: string): string {
  const envName = ROOT_ENV[rootId]
  if (envName === undefined) {
    throw new Error(`未知 rootId: ${rootId}`)
  }
  const fromEnv = process.env[envName]
  const base = fromEnv ? fromEnv : join(homedir(), 'Downloads')
  return toPosix(resolve(base))
}
