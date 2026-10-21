import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { SinkFileSystem } from './jsonl-sink'
import type { LogStore } from './logs-ipc'

function readdirIfExists(path: string): string[] {
  try {
    return readdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export const nodeFileSystem: SinkFileSystem = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  appendFile: (path, data) => appendFileSync(path, data, 'utf8'),
  readdir: (path) => readdirIfExists(path),
  stat: (path) => ({ size: statSync(path).size }),
  unlink: (path) => unlinkSync(path)
}

export function createNodeLogStore(dir: string): LogStore {
  return {
    listFiles: () => readdirIfExists(dir),
    readFile: (name) => readFileSync(join(dir, name), 'utf8'),
    removeFile: (name) => unlinkSync(join(dir, name))
  }
}
