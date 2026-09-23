import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getPgPool, closePgPool, checkPgHealth } from './postgres'

describe('PostgreSQL Infrastructure (Phase 1)', () => {
  beforeAll(async () => {
    // 确保连接池已初始化
    getPgPool()
  })

  afterAll(async () => {
    await closePgPool()
  })

  it('连接池健康检查正常并具备 vector 与 pg_jieba 扩展', async () => {
    const health = await checkPgHealth()
    expect(health.ok).toBe(true)
    expect(health.version).toContain('PostgreSQL 17')
    expect(health.extensions).toContain('vector')
    expect(health.extensions).toContain('pg_jieba')
  })

  it('中文全文检索分词正常工作', async () => {
    const pool = getPgPool()
    const res = await pool.query<{ matched: boolean }>(
      `SELECT to_tsvector('jiebacfg', '中华人民共和国刑法关于过失致人重伤罪的规定') @@ to_tsquery('jiebacfg', '过失 & 重伤') AS matched`
    )
    expect(res.rows[0]?.matched).toBe(true)
  })

  it('文档与分块表 CRUD、外键级联删除及向量/全文索引生成验证', async () => {
    const pool = getPgPool()
    const testPath = `/tmp/test-doc-${Date.now()}.pdf`

    // 1. 插入文档元数据
    const docRes = await pool.query<{ id: string }>(
      `INSERT INTO documents (source_path, file_name, file_type, file_size, file_hash, page_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [testPath, 'test.pdf', 'pdf', 1024, 'hash_abc123', 5]
    )
    const docId = docRes.rows[0].id
    expect(docId).toBeDefined()

    // 2. 插入分块，带有 1024 维向量与中文文本
    // 构造 1024 维的测试向量字符串: [0.1, 0.2, ...]
    const vectorData = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1.0 : 0.0)).join(',')}]`
    const rawText = '第四章 侵犯公民人身权利、民主权利罪：过失重伤他人的，处三年以下有期徒刑。'

    const chunkRes = await pool.query<{ id: string; fts: string }>(
      `INSERT INTO chunks (
         document_id, chunk_index, page_numbers, heading_path, raw_text, dense_embedding
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, fts_vector::text as fts`,
      [docId, 0, [4], '第四章/第235条', rawText, vectorData]
    )
    const chunkId = chunkRes.rows[0].id
    expect(chunkId).toBeDefined()
    // fts_vector 应当被 GENERATED ALWAYS 自动生成
    expect(chunkRes.rows[0].fts).toBeDefined()
    expect(chunkRes.rows[0].fts.length).toBeGreaterThan(0)

    // 3. 全文检索查询 chunk
    const ftsQuery = await pool.query<{ id: string; raw_text: string }>(
      `SELECT id, raw_text FROM chunks
       WHERE document_id = $1 AND fts_vector @@ to_tsquery('jiebacfg', '有期徒刑')`,
      [docId]
    )
    expect(ftsQuery.rows.length).toBe(1)
    expect(ftsQuery.rows[0].id).toBe(chunkId)

    // 4. 向量余弦距离查询
    const queryVector = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 0.95 : i === 1 ? 0.05 : 0.0)).join(',')}]`
    const vecQuery = await pool.query<{ id: string; distance: number }>(
      `SELECT id, dense_embedding <=> $1 AS distance
       FROM chunks
       WHERE document_id = $2
       ORDER BY dense_embedding <=> $1
       LIMIT 1`,
      [queryVector, docId]
    )
    expect(vecQuery.rows.length).toBe(1)
    expect(vecQuery.rows[0].distance).toBeLessThan(0.1)

    // 5. 验证外键级联删除
    await pool.query('DELETE FROM documents WHERE id = $1', [docId])
    const checkChunk = await pool.query('SELECT id FROM chunks WHERE id = $1', [chunkId])
    expect(checkChunk.rows.length).toBe(0)
  })
})
