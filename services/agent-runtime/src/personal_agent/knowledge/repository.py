"""PostgreSQL 知识库底层数据仓储层。

负责 documents 与 chunks 表的增删改查、事务原子性与中文全文检索探测。
"""

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from personal_agent.knowledge.models import DocumentChunk, DocumentRecord


async def upsert_document(pool: asyncpg.Pool, doc: DocumentRecord) -> UUID:
    """插入或更新文档记录，若已存在相同 source_path 则更新元数据。"""
    query = """
    INSERT INTO documents (id, source_path, file_name, file_type, file_size, file_hash, parsed_at, page_count, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (source_path) DO UPDATE SET
        file_name = EXCLUDED.file_name,
        file_type = EXCLUDED.file_type,
        file_size = EXCLUDED.file_size,
        file_hash = EXCLUDED.file_hash,
        parsed_at = EXCLUDED.parsed_at,
        page_count = EXCLUDED.page_count,
        updated_at = EXCLUDED.updated_at
    RETURNING id;
    """
    doc_id = doc.id or uuid4()
    now = datetime.now(UTC)
    parsed_at = doc.parsed_at or now

    async with pool.acquire() as conn:
        res_id = await conn.fetchval(
            query,
            doc_id,
            doc.source_path,
            doc.file_name,
            doc.file_type,
            doc.file_size,
            doc.file_hash,
            parsed_at,
            doc.page_count,
            now,
        )
        return UUID(str(res_id))


async def delete_chunks_by_document(pool: asyncpg.Pool, document_id: UUID) -> int:
    """删除指定文档的所有已存分块。"""
    query = "DELETE FROM chunks WHERE document_id = $1;"
    async with pool.acquire() as conn:
        res = await conn.execute(query, document_id)
        # res 格式形如 "DELETE 5"
        try:
            return int(res.split(" ")[-1])
        except (IndexError, ValueError):
            return 0


async def batch_insert_chunks(
    pool: asyncpg.Pool,
    document_id: UUID,
    chunks: list[DocumentChunk],
) -> int:
    """批量插入文档分块，支持稠密向量与稀疏向量，fts_vector 列由 PostgreSQL jiebacfg 表达式自动计算。"""
    if not chunks:
        return 0

    query = """
    INSERT INTO chunks (
        document_id, chunk_index, page_numbers, heading_path, raw_text, token_count,
        dense_embedding, sparse_vector
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
    """
    records = [
        (
            document_id,
            c.chunk_index,
            c.page_numbers,
            c.heading_path,
            c.raw_text,
            c.token_count,
            c.dense_embedding,
            json.dumps(c.sparse_vector) if c.sparse_vector else None,
        )
        for c in chunks
    ]

    async with pool.acquire() as conn:
        await conn.executemany(query, records)
        return len(records)


async def get_document_by_path(pool: asyncpg.Pool, source_path: str) -> dict[str, Any] | None:
    """根据文件绝对路径查询文档元数据。"""
    query = "SELECT * FROM documents WHERE source_path = $1 LIMIT 1;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, source_path)
        return dict(row) if row else None


async def get_chunks_by_document_id(
    pool: asyncpg.Pool,
    document_id: UUID,
) -> list[dict[str, Any]]:
    """查询指定文档下的全部切块，按 chunk_index 升序排序。"""
    query = """
    SELECT id, document_id, chunk_index, page_numbers, heading_path, raw_text, token_count,
           dense_embedding, sparse_vector, created_at
    FROM chunks
    WHERE document_id = $1
    ORDER BY chunk_index ASC;
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, document_id)
        return [dict(r) for r in rows]


async def delete_document(pool: asyncpg.Pool, document_id: UUID) -> bool:
    """删除文档元数据（借助 ON DELETE CASCADE 自动级联清理关联 chunks）。"""
    query = "DELETE FROM documents WHERE id = $1;"
    async with pool.acquire() as conn:
        res = await conn.execute(query, document_id)
        return "DELETE 1" in res


async def search_chunks_fts(
    pool: asyncpg.Pool,
    query_text: str,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """使用 pg_jieba 中文分词对 chunks 表进行全文检索验证。"""
    query = """
    SELECT id, document_id, chunk_index, heading_path, raw_text,
           ts_rank_cd(fts_vector, to_tsquery('jiebacfg', $1)) AS rank
    FROM chunks
    WHERE fts_vector @@ to_tsquery('jiebacfg', $1)
    ORDER BY rank DESC
    LIMIT $2;
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, query_text, limit)
        return [dict(r) for r in rows]
