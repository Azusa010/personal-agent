import type { Pool } from 'pg'
import type { UserMemoryCard, MemoryType, MemoryCategory } from '@personal-agent/protocol'

export interface FetchActiveMemoriesOptions {
  memoryType?: MemoryType
  category?: MemoryCategory
  limit?: number
}

interface DbMemoryRow {
  id: string
  memory_type: string
  category: string
  subject: string
  person: string | null
  relationship: string | null
  content: string | Record<string, unknown>
  backstory: string | null
  source_task_id: string | null
  confidence: number | string | null
  occurred_at: string | Date | null
  valid_from: string | Date
  superseded_by: string | null
  supersede_reason: string | null
  access_count: number | string | null
  last_accessed_at: string | Date | null
  is_sanitized: boolean | null
  created_at: string | Date
  updated_at: string | Date
}

function toIsoString(val: string | Date | null | undefined): string | null {
  if (val === null || val === undefined) return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

export function mapRowToMemoryCard(row: DbMemoryRow): UserMemoryCard {
  const rawContent = row.content
  const parsedContent =
    typeof rawContent === 'string'
      ? (JSON.parse(rawContent) as Record<string, unknown>)
      : (rawContent as Record<string, unknown>) || {}

  return {
    id: row.id,
    memoryType: row.memory_type as MemoryType,
    category: row.category as MemoryCategory,
    subject: row.subject || '',
    person: row.person ?? undefined,
    relationship: row.relationship ?? undefined,
    content: parsedContent,
    backstory: row.backstory ?? undefined,
    sourceTaskId: row.source_task_id ?? undefined,
    confidence:
      row.confidence !== null && row.confidence !== undefined ? Number(row.confidence) : 1.0,
    occurredAt: toIsoString(row.occurred_at) ?? undefined,
    validFrom: toIsoString(row.valid_from) || new Date().toISOString(),
    supersededBy: row.superseded_by ?? undefined,
    supersedeReason: row.supersede_reason ?? undefined,
    accessCount:
      row.access_count !== null && row.access_count !== undefined ? Number(row.access_count) : 0,
    lastAccessedAt: toIsoString(row.last_accessed_at) ?? undefined,
    isSanitized: Boolean(row.is_sanitized),
    createdAt: toIsoString(row.created_at) || new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) || new Date().toISOString()
  }
}

/**
 * 获取当前活跃的用户记忆（L1 常驻层使用：superseded_by IS NULL）
 */
export async function fetchActiveMemories(
  pool: Pool,
  options?: FetchActiveMemoriesOptions
): Promise<UserMemoryCard[]> {
  const conditions: string[] = ['superseded_by IS NULL']
  const params: unknown[] = []

  if (options?.memoryType) {
    params.push(options.memoryType)
    conditions.push(`memory_type = $${params.length}`)
  }

  if (options?.category) {
    params.push(options.category)
    conditions.push(`category = $${params.length}`)
  }

  const limit = options?.limit ?? 30
  params.push(limit)

  const query = `
    SELECT id, memory_type, category, subject, person, relationship,
           content, backstory, source_task_id, confidence, occurred_at,
           valid_from, superseded_by, supersede_reason, access_count,
           last_accessed_at, is_sanitized, created_at, updated_at
    FROM user_memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY confidence DESC, access_count DESC, COALESCE(occurred_at, created_at) DESC
    LIMIT $${params.length};
  `

  const res = await pool.query<DbMemoryRow>(query, params)
  return res.rows.map(mapRowToMemoryCard)
}

/**
 * 插入一条用户记忆卡片
 */
export async function insertUserMemory(pool: Pool, card: UserMemoryCard): Promise<string> {
  const query = `
    INSERT INTO user_memories (
      id, memory_type, category, subject, person, relationship,
      content, backstory, source_task_id, confidence, occurred_at,
      valid_from, superseded_by, supersede_reason, access_count,
      last_accessed_at, is_sanitized, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15,
      $16, $17, $18, $19
    )
    RETURNING id;
  `
  const params = [
    card.id,
    card.memoryType,
    card.category,
    card.subject,
    card.person ?? null,
    card.relationship ?? null,
    JSON.stringify(card.content),
    card.backstory ?? null,
    card.sourceTaskId ?? null,
    card.confidence,
    card.occurredAt ? new Date(card.occurredAt) : null,
    card.validFrom ? new Date(card.validFrom) : new Date(),
    card.supersededBy ?? null,
    card.supersedeReason ?? null,
    card.accessCount,
    card.lastAccessedAt ? new Date(card.lastAccessedAt) : null,
    card.isSanitized,
    card.createdAt ? new Date(card.createdAt) : new Date(),
    card.updatedAt ? new Date(card.updatedAt) : new Date()
  ]

  const res = await pool.query<{ id: string }>(query, params)
  return res.rows[0].id
}

/**
 * 根据 ID 查询单条记忆
 */
export async function findUserMemoryById(pool: Pool, id: string): Promise<UserMemoryCard | null> {
  const query = `
    SELECT id, memory_type, category, subject, person, relationship,
           content, backstory, source_task_id, confidence, occurred_at,
           valid_from, superseded_by, supersede_reason, access_count,
           last_accessed_at, is_sanitized, created_at, updated_at
    FROM user_memories
    WHERE id = $1
    LIMIT 1;
  `
  const res = await pool.query<DbMemoryRow>(query, [id])
  if (res.rows.length === 0) return null
  return mapRowToMemoryCard(res.rows[0])
}

/**
 * 统计当前活跃记忆总数
 */
export async function countActiveMemories(pool: Pool): Promise<number> {
  const res = await pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM user_memories WHERE superseded_by IS NULL;'
  )
  return Number(res.rows[0]?.count || 0)
}
