import { MESSAGE_ROLES, MessageRole, type MessageRecord } from '../../shared/domain'
import { SqliteDatabase } from './database'

export type { MessageRecord, MessageRole }
export { MESSAGE_ROLES }

interface MessageRow {
  seq: number
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  text: string
  task_id: string | null
  created_at: string
}

function toRecord(row: MessageRow): MessageRecord {
  if (!(MESSAGE_ROLES as readonly string[]).includes(row.role)) {
    throw new Error(`messages.role 出现 CHECK 未拦住的非法值: ${row.role} (id=${row.id})`)
  }

  return {
    seq: row.seq,
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    text: row.text,
    taskId: row.task_id,
    createdAt: row.created_at
  }
}

export type newMessage = Omit<MessageRecord, 'seq'>
export interface MessageRepository {
  append(record: newMessage): number
  listByConversation(conversationId: string): MessageRecord[]
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(private db: SqliteDatabase) {}

  append(record: newMessage): number {
    const info = this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, text, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.conversationId,
        record.role,
        record.text,
        record.taskId,
        record.createdAt
      )
    return Number(info.lastInsertRowid)
  }

  listByConversation(conversationId: string): MessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT seq, id, conversation_id, role, text, task_id, created_at FROM messages WHERE conversation_id = ? ORDER BY seq ASC`
      )
      .all(conversationId) as MessageRow[]
    return rows.map(toRecord)
  }
}
