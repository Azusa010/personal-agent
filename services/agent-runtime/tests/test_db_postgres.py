"""PostgreSQL 基础设施与 pgvector / pg_jieba 集成测试。"""

import asyncio
import time

from personal_agent.db.postgres import check_pg_health, close_pg_pool, get_pg_pool


def test_postgres_health_and_extensions():
    """验证数据库连通性并检查 vector 与 pg_jieba 扩展。"""

    async def _run():
        try:
            health = await check_pg_health()
            assert health["ok"] is True
            assert "PostgreSQL 17" in health["version"]
            assert "vector" in health["extensions"]
            assert "pg_jieba" in health["extensions"]
        finally:
            await close_pg_pool()

    asyncio.run(_run())


def test_jieba_chinese_fts():
    """验证 pg_jieba 中文全文检索。"""

    async def _run():
        try:
            pool = await get_pg_pool()
            async with pool.acquire() as conn:
                matched = await conn.fetchval(
                    "SELECT to_tsvector('jiebacfg', $1) @@ to_tsquery('jiebacfg', $2)",
                    "深入理解AI智能体架构与检索增强生成技术",
                    "智能体 & 检索",
                )
                assert matched is True
        finally:
            await close_pg_pool()

    asyncio.run(_run())


def test_pgvector_and_chunks_crud():
    """验证向量存储、余弦距离计算、全文检索自动生成以及级联删除。"""

    async def _run():
        try:
            pool = await get_pg_pool()
            doc_path = f"/tmp/py-test-{int(time.time() * 1000)}.pdf"

            async with pool.acquire() as conn:
                # 1. 插入文档
                doc_id = await conn.fetchval(
                    """
                    INSERT INTO documents (source_path, file_name, file_type, file_size, file_hash, page_count)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id
                    """,
                    doc_path,
                    "py-test.pdf",
                    "pdf",
                    2048,
                    "hash_py_test",
                    10,
                )
                assert doc_id is not None

                # 2. 构造 1024 维向量并插入 chunk
                dense_vec = [0.0] * 1024
                dense_vec[0] = 1.0

                raw_text = "第三章 检索增强生成：通过结合稠密检索与稀疏检索实现高质量问答。"

                chunk_id = await conn.fetchval(
                    """
                    INSERT INTO chunks (
                        document_id, chunk_index, page_numbers, heading_path, raw_text, dense_embedding
                    )
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id
                    """,
                    doc_id,
                    0,
                    [3],
                    "第3章/3.1节",
                    raw_text,
                    dense_vec,
                )
                assert chunk_id is not None

                # 3. 验证自动生成的 fts_vector 检索
                found_chunk_id = await conn.fetchval(
                    """
                    SELECT id FROM chunks
                    WHERE document_id = $1 AND fts_vector @@ to_tsquery('jiebacfg', '稠密检索')
                    """,
                    doc_id,
                )
                assert found_chunk_id == chunk_id

                # 4. 向量余弦检索 (<=>)
                query_vec = [0.0] * 1024
                query_vec[0] = 0.95
                query_vec[1] = 0.05

                row = await conn.fetchrow(
                    """
                    SELECT id, dense_embedding <=> $1 AS distance
                    FROM chunks
                    WHERE document_id = $2
                    ORDER BY dense_embedding <=> $1
                    LIMIT 1
                    """,
                    query_vec,
                    doc_id,
                )
                assert row is not None
                assert row["id"] == chunk_id
                assert row["distance"] < 0.1

                # 5. 级联删除清理
                await conn.execute("DELETE FROM documents WHERE id = $1", doc_id)
                rem = await conn.fetchval("SELECT count(*) FROM chunks WHERE id = $1", chunk_id)
                assert rem == 0
        finally:
            await close_pg_pool()

    asyncio.run(_run())
