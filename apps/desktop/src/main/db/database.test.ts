import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase, MEMORY_DB, type SqliteDatabase } from './database'

let memDb: SqliteDatabase | null = null
let fileDb: SqliteDatabase | null = null
let tmpDir: string | null = null

afterEach(() => {
  memDb?.close()
  memDb = null
  fileDb?.close()
  fileDb = null
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

describe('openDatabase', () => {
  it('内存库:WAL 请求被 SQLite 降级为 memory', () => {
    memDb = openDatabase(MEMORY_DB)
    expect(memDb.pragma('journal_mode', { simple: true })).toBe('memory')
  })

  it('文件库:journal_mode 真的切到 wal', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pa-db-'))
    fileDb = openDatabase(join(tmpDir, 'personal-agent.db'))
    expect(fileDb.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('建出 pdf_files 的 7 列，列名与顺序钉死', () => {
    memDb = openDatabase(MEMORY_DB)
    const cols = memDb
      .prepare(`SELECT name FROM pragma_table_info('pdf_files') ORDER BY cid`)
      .all() as { name: string }[]
    expect(cols.map((c) => c.name)).toEqual([
      'absolute_path',
      'root_id',
      'name',
      'modified_at',
      'size_bytes',
      'first_seen_at',
      'last_seen_at'
    ])
  })
})
