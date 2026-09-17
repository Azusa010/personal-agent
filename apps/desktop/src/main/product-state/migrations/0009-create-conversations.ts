import { Migration } from './0001-create-tasks'

const CONVERSATIONS_DDL = `
  CREATE TABLE conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`
const MESSAGE_DDL = `
   CREATE TABLE messages (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text            TEXT NOT NULL,
    task_id         TEXT REFERENCES tasks(id),
    created_at      TEXT NOT NULL
  )
`

const TASKS_CONVERSATION_DDL = `
  ALTER TABLE tasks ADD COLUMN conversation_id TEXT REFERENCES conversations(id)
`

export const M0009_CREATE_CONVERSATIONS: Migration = {
  version: 9,
  name: 'create-conversations',
  up: (db) => {
    db.exec(CONVERSATIONS_DDL)
    db.exec(MESSAGE_DDL)
    db.exec(TASKS_CONVERSATION_DDL)
  }
}
