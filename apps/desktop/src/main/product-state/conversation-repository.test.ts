import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { ConversationRecord, SqliteConversationRepository } from './conversation-repository'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

function makeRepo(): SqliteConversationRepository {
  const d = openProductState(MEMORY_DB)
  db = d
  migrate(d)
  return new SqliteConversationRepository(d)
}

function conversation(id: string, updatedAt = '2026-09-17T10:00:00.000Z'): ConversationRecord {
  return {
    id,
    title: `会话 ${id}`,
    createdAt: '2026-09-17T09:00:00.000Z',
    updatedAt
  }
}

describe('SqliteConversationRepository', () => {
  it('insert 后 findById 原样读回（蛇 → 驼映射）', () => {
    const repo = makeRepo()

    repo.insert(conversation('c-1'))

    expect(repo.findById('c-1')).toEqual(conversation('c-1'))
  })

  it('findById 查不到 → null（不抛错：侧栏空态要走这条）', () => {
    const repo = makeRepo()

    expect(repo.findById('不存在')).toBeNull()
  })

  it('list 按最近更新倒序（侧栏第一条是刚用过的那个）', () => {
    const repo = makeRepo()
    repo.insert(conversation('c-old', '2026-09-17T08:00:00.000Z'))
    repo.insert(conversation('c-new', '2026-09-17T12:00:00.000Z'))

    expect(repo.list().map((c) => c.id)).toEqual(['c-new', 'c-old'])
  })

  it('touch 只刷 updated_at，其余字段不动', () => {
    const repo = makeRepo()
    repo.insert(conversation('c-1'))
    const next = '2026-09-17T15:00:00.000Z'

    repo.touch('c-1', next)

    const after = repo.findById('c-1')
    expect(after?.updatedAt).toBe(next)
    expect(after?.createdAt).toBe('2026-09-17T09:00:00.000Z')
    expect(after?.title).toBe('会话 c-1')
  })

  it('touch 不存在的会话 → 静默无效果（不抛：不该让编排层为编造的 id 炸掉）', () => {
    const repo = makeRepo()

    expect(() => repo.touch('不存在', '2026-09-17T15:00:00.000Z')).not.toThrow()
  })
})
