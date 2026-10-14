import { BotRecord } from 'src/shared/domain'
import { SqliteDatabase } from './database'
import { UpdateBotInput } from 'src/shared/ipc-contract'
export type { BotRecord }

interface BotRow {
  id: string
  name: string
  description: string
  is_default: number
  created_at: string
  updated_at: string
  avatar: string
  persona: string
}

function toRecord(row: BotRow): BotRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    avatar: row.avatar,
    persona: row.persona
  }
}

export interface BotRepository {
  insert(record: BotRecord): void
  findById(id: string): BotRecord | null
  findDefault(): BotRecord | null
  list(): BotRecord[]
  update(bot: UpdateBotInput): void
}

export class SqliteBotRepository implements BotRepository {
  constructor(private db: SqliteDatabase) {}

  insert(record: BotRecord): void {
    this.db
      .prepare(
        `INSERT INTO bots (id, name, description, is_default, created_at, updated_at, avatar, persona) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.name,
        record.description,
        record.isDefault ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        record.avatar,
        record.persona
      )
  }

  findById(id: string): BotRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, is_default, created_at, updated_at, avatar, persona FROM bots WHERE id = ?`
      )
      .get(id) as BotRow | undefined
    return row === undefined ? null : toRecord(row)
  }

  findDefault(): BotRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, is_default, created_at, updated_at, avatar, persona FROM bots WHERE is_default = 1`
      )
      .get() as BotRow | undefined
    return row === undefined ? null : toRecord(row)
  }

  list(): BotRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, is_default, created_at, updated_at, avatar, persona FROM bots ORDER BY is_default DESC,created_at ASC`
      )
      .all() as BotRow[]
    return rows.map(toRecord)
  }

  update(bot: UpdateBotInput): void {
    const current = this.findById(bot.id)
    if (!current) {
      return
    }
    this.db
      .prepare(
        `UPDATE bots SET updated_at = ?, name = ?, avatar = ?, persona = ?, description = ? WHERE id = ?`
      )
      .run(
        bot.updatedAt,
        bot.name ?? current.name,
        bot.avatar ?? current.avatar,
        bot.persona ?? current.persona,
        bot.description ?? current.description,
        bot.id
      )
  }
}
