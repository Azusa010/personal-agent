import { describe, it, expect, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  mapRowToMemoryCard,
  fetchActiveMemories,
  insertUserMemory,
  findUserMemoryById,
  countActiveMemories
} from './user-memory-repository'
import type { UserMemoryCard } from '@personal-agent/protocol'

describe('user-memory-repository (Desktop Main)', () => {
  it('mapRowToMemoryCard 能正确解析数据库行并映射为 UserMemoryCard', () => {
    const fakeRow = {
      id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
      memory_type: 'semantic',
      category: 'preference',
      subject: '报告样式',
      person: '本人',
      relationship: '本人',
      content: JSON.stringify({ format: 'table', detail: 'high' }),
      backstory: '2026年9月汇报时提及',
      source_task_id: 'task-report-1',
      confidence: 0.95,
      occurred_at: new Date('2026-09-24T10:00:00Z'),
      valid_from: new Date('2026-09-24T10:00:00Z'),
      superseded_by: null,
      supersede_reason: null,
      access_count: 8,
      last_accessed_at: new Date('2026-09-24T12:00:00Z'),
      is_sanitized: true,
      created_at: new Date('2026-09-24T10:00:00Z'),
      updated_at: new Date('2026-09-24T12:00:00Z')
    }

    const card = mapRowToMemoryCard(fakeRow)
    expect(card.id).toBe(fakeRow.id)
    expect(card.memoryType).toBe('semantic')
    expect(card.category).toBe('preference')
    expect(card.subject).toBe('报告样式')
    expect(card.person).toBe('本人')
    expect(card.relationship).toBe('本人')
    expect(card.content).toEqual({ format: 'table', detail: 'high' })
    expect(card.confidence).toBe(0.95)
    expect(card.accessCount).toBe(8)
    expect(card.isSanitized).toBe(true)
    expect(card.occurredAt).toBe('2026-09-24T10:00:00.000Z')
    expect(card.supersededBy).toBeUndefined()
  })

  it('fetchActiveMemories 构建正确的 SQL 查询并支持过滤', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '11111111-2222-4333-8444-555555555555',
          memory_type: 'semantic',
          category: 'preference',
          subject: '测试',
          person: null,
          relationship: null,
          content: {},
          backstory: null,
          source_task_id: null,
          confidence: 1.0,
          occurred_at: null,
          valid_from: new Date('2026-01-01T00:00:00Z'),
          superseded_by: null,
          supersede_reason: null,
          access_count: 0,
          last_accessed_at: null,
          is_sanitized: false,
          created_at: new Date('2026-01-01T00:00:00Z'),
          updated_at: new Date('2026-01-01T00:00:00Z')
        }
      ]
    })
    const fakePool = { query: mockQuery } as unknown as Pool

    const cards = await fetchActiveMemories(fakePool, {
      memoryType: 'semantic',
      category: 'preference',
      limit: 10
    })

    expect(cards).toHaveLength(1)
    expect(cards[0].subject).toBe('测试')
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('superseded_by IS NULL')
    expect(sql).toContain('memory_type = $1')
    expect(sql).toContain('category = $2')
    expect(sql).toContain('LIMIT $3')
  })

  it('insertUserMemory 序列化参数并返回新 ID', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ id: 'new-mem-uuid' }]
    })
    const fakePool = { query: mockQuery } as unknown as Pool

    const testCard: UserMemoryCard = {
      entryFormat: 'card',
      id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
      memoryType: 'procedural',
      category: 'routine',
      subject: '部署发布',
      content: { command: 'pnpm verify' },
      confidence: 1.0,
      validFrom: '2026-09-24T10:00:00.000Z',
      accessCount: 0,
      isSanitized: false,
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt: '2026-09-24T10:00:00.000Z'
    }

    const resId = await insertUserMemory(fakePool, testCard)
    expect(resId).toBe('new-mem-uuid')
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe(testCard.id)
    expect(params[1]).toBe('procedural')
    expect(params[6]).toBe(JSON.stringify({ command: 'pnpm verify' }))
  })

  it('findUserMemoryById 查不到记录时返回 null', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
    const fakePool = { query: mockQuery } as unknown as Pool

    const card = await findUserMemoryById(fakePool, 'non-existent')
    expect(card).toBeNull()
  })

  it('countActiveMemories 正确统计活跃数量', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '42' }] })
    const fakePool = { query: mockQuery } as unknown as Pool

    const count = await countActiveMemories(fakePool)
    expect(count).toBe(42)
  })
})
