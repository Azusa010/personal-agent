import { Migration } from './0001-create-tasks'

const BOTS_DDL = `
  CREATE TABLE bots (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    avatar     TEXT NOT NULL,
    persona   TEXT NOT NULL,
    description TEXT NOT NULL,
    is_default INTEGER NOT NULL CHECK (is_default IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`

const conversationBotIdDDL = `
  ALTER TABLE conversations ADD COLUMN bot_id TEXT REFERENCES bots(id)
`

export const M0010_CREATE_BOTS: Migration = {
  version: 10,
  name: 'create-bots',
  up: (db) => {
    db.exec(BOTS_DDL)
    db.exec(conversationBotIdDDL)
    db.exec(
      "INSERT INTO bots (id, name, avatar, persona, description, is_default, created_at, updated_at) VALUES ('bot-default', 'PersonalAgent', '🤖', '默认全能伴侣与系统调度助手', '系统默认主智能体，提供全局任务编排与全能对话支持', 1, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')"
    )
    db.exec(
      "INSERT INTO bots (id, name, avatar, persona, description, is_default, created_at, updated_at) VALUES ('bot-coder', '代码极客', '💻', '专注于系统架构、精益编码与全栈工程实现的极客助手', '负责架构设计、代码生成与重构建议', 0, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')"
    )
    db.exec(
      "INSERT INTO bots (id, name, avatar, persona, description, is_default, created_at, updated_at) VALUES ('bot-analyst', '深度分析师', '🔍', '具备缜密逻辑推理与商业研报洞察力的资深分析专家', '负责深度研报分析、数据挖掘与策略推导', 0, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')"
    )
    db.exec(
      "INSERT INTO conversations (id, bot_id, title, created_at, updated_at) VALUES ('c-bot-default', 'bot-default', 'Default Conversation', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')"
    )
    db.exec(
      "INSERT INTO conversations (id, bot_id, title, created_at, updated_at) VALUES ('c-bot-coder', 'bot-coder', 'Coding Conversation', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')"
    )
    db.exec(
      "INSERT INTO conversations (id, bot_id, title, created_at, updated_at) VALUES ('c-bot-analyst', 'bot-analyst', 'Analytical Conversation', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')"
    )
    db.exec("UPDATE conversations SET bot_id = 'bot-default' WHERE bot_id IS NULL")
  }
}
