import type { ConversationRecord } from 'src/shared/domain'
import type { SqliteDatabase } from './database'

export type { ConversationRecord }

interface ConversationRow {
  id: string
  bot_id: string
  title: string
  created_at: string
  updated_at: string
}

function toRecord(row: ConversationRow): ConversationRecord {
  const record: ConversationRecord = {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (row.bot_id !== null && row.bot_id !== undefined) {
    record.botId = row.bot_id
  }
  return record
}

export interface ConversationRepository {
  insert(record: ConversationRecord): void
  findById(id: string): ConversationRecord | null
  findByBotId(botId: string): ConversationRecord | null
  list(): ConversationRecord[]
  // 刷一次 updated_at，表示这个会话刚被用过
  touch(id: string, updatedAt: string): void
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private db: SqliteDatabase) {}

  insert(record: ConversationRecord): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, bot_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(record.id, record.botId, record.title, record.createdAt, record.updatedAt)
  }

  findById(id: string): ConversationRecord | null {
    const row = this.db
      .prepare(`SELECT id, bot_id, title, created_at, updated_at FROM conversations WHERE id = ?`)
      .get(id) as ConversationRow | undefined
    return row === undefined ? null : toRecord(row)
  }
  findByBotId(botId: string): ConversationRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, bot_id, title, created_at, updated_at FROM conversations WHERE bot_id = ?`
      )
      .get(botId) as ConversationRow | undefined
    return row === undefined ? null : toRecord(row)
  }

  list(): ConversationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, bot_id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC`
      )
      .all() as ConversationRow[]
    return rows.map(toRecord)
  }

  touch(id: string, updatedAt: string): void {
    this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(updatedAt, id)
  }
}
