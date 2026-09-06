import type { PdfEntry } from '@personal-agent/protocol'
import type { IndexedPdfEntry } from '../../shared/ipc-contract'
import type { SqliteDatabase } from './database'

interface DbRow {
  absolute_path: string
  root_id: string
  name: string
  modified_at: string
  size_bytes: number
  first_seen_at: string
  last_seen_at: string
}

const UPSERT_SQL = `
    INSERT INTO pdf_files
    (absolute_path, root_id, name, modified_at, size_bytes, first_seen_at, last_seen_at)
  VALUES
    (@absolutePath, @rootId, @name, @modifiedAt, @sizeBytes, @seenAt, @seenAt)
  ON CONFLICT(absolute_path) DO UPDATE SET
    name         = excluded.name,
    modified_at  = excluded.modified_at,
    size_bytes   = excluded.size_bytes,
    last_seen_at = excluded.last_seen_at
`
const SELECT_SQL = `
  SELECT absolute_path, root_id, name, modified_at, size_bytes, first_seen_at, last_seen_at
  FROM pdf_files
  ORDER BY modified_at DESC
`

export function upsertMany(
  db: SqliteDatabase,
  rootId: string,
  entries: PdfEntry[],
  nowIso: string
): void {
  if (entries.length === 0) return
  const stmt = db.prepare(UPSERT_SQL)
  const runAll = db.transaction((rows: PdfEntry[]) => {
    for (const e of rows) {
      stmt.run({
        absolutePath: e.absolutePath,
        rootId,
        name: e.name,
        modifiedAt: e.modifiedAt,
        sizeBytes: e.sizeBytes,
        seenAt: nowIso
      })
    }
  })
  runAll(entries)
}

export function findAll(db: SqliteDatabase): IndexedPdfEntry[] {
  const rows = db.prepare(SELECT_SQL).all() as DbRow[]
  const all_rows = rows.map((r) => ({
    name: r.name,
    absolutePath: r.absolute_path,
    modifiedAt: r.modified_at,
    sizeBytes: r.size_bytes,
    rootId: r.root_id,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at
  }))
  return all_rows as unknown as IndexedPdfEntry[]
}
