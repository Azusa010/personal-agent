import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type SqliteDatabase } from './database'
import { upsertMany, findAll } from './pdf-repository'

const T1 = '2026-09-06T00:00:00Z'
const T2 = '2026-09-07T00:00:00Z'

const entry = {
  name: 'a.pdf',
  absolutePath: 'C:/Downloads/a.pdf',
  modifiedAt: '2026-01-01T00:00:00Z',
  sizeBytes: 1024
}

let db: SqliteDatabase

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('pdf-repository', () => {
  it('空值返回空数组', () => {
    expect(findAll(db)).toEqual([])
  })
  it('upsert 后能读回', () => {
    upsertMany(db, 'downloads', [entry], T1)
    expect(findAll(db)).toEqual([
      { ...entry, rootId: 'downloads', firstSeenAt: T1, lastSeenAt: T1 }
    ])
  })
  it('重复 upsert:镜像字段更新,first_seen_at 保住,且不产生重复行', () => {
    upsertMany(db, 'downloads', [entry], T1)
    upsertMany(db, 'downloads', [{ ...entry, name: 'renamed.pdf', sizeBytes: 2048 }], T2)

    const rows = findAll(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('renamed.pdf')
    expect(rows[0].sizeBytes).toBe(2048)
    expect(rows[0].firstSeenAt).toBe(T1)
    expect(rows[0].lastSeenAt).toBe(T2)
  })
  it('空 entries 直接返回,不炸事物', () => {
    upsertMany(db, 'downloads', [], T1)
    expect(findAll(db)).toEqual([])
  })
  it('多条按 modified_at 倒序', () => {
    upsertMany(
      db,
      'downloads',
      [
        {
          ...entry,
          name: 'old.pdf',
          absolutePath: 'C:/Downloads/old.pdf',
          modifiedAt: '2025-01-01T00:00:00Z'
        },
        {
          ...entry,
          name: 'new.pdf',
          absolutePath: 'C:/Downloads/new.pdf',
          modifiedAt: '2026-01-01T00:00:00Z'
        }
      ],
      T1
    )
    expect(findAll(db).map((r) => r.name)).toEqual(['new.pdf', 'old.pdf'])
  })
})
