"""知识库评测数据真实入库与生命周期管理 (Knowledge DB Seeder)。

负责将评测用例中的知识分块与元数据真实写入 PostgreSQL 数据库的 documents 与 chunks 表：
1. 自动生成 1024 维稠密嵌入向量并落库；
2. 触发 PostgreSQL jiebacfg 表达式自动生成 fts_vector 中文倒排索引；
3. 将 chunk.id 编码至 heading_path 便于精确溯源比对；
4. 评测结束后执行级联清理，杜绝数据库污染。
"""

from __future__ import annotations

import logging
from collections import defaultdict
from pathlib import Path
from uuid import UUID, uuid4

import asyncpg

from personal_agent.eval.knowledge_models import KnowledgeChunkData, KnowledgeEvalCase
from personal_agent.knowledge.embedder import BaseEmbedder
from personal_agent.knowledge.models import DocumentChunk, DocumentRecord
from personal_agent.knowledge.repository import (
    batch_insert_chunks,
    delete_chunks_by_document,
    upsert_document,
)

logger = logging.getLogger("personal_agent.eval.knowledge_db_seeder")


async def seed_knowledge_corpus(
    pool: asyncpg.Pool,
    cases: list[KnowledgeEvalCase],
    embedder: BaseEmbedder,
    prefix_tag: str = "eval_run",
) -> tuple[dict[str, UUID], list[UUID]]:
    """将评测集所有分块真实持久化至 PostgreSQL。

    Returns:
        (chunk_id_to_doc_id, inserted_document_ids)
    """
    # 汇总去重所有 chunks
    unique_chunks: dict[str, KnowledgeChunkData] = {}
    for c in cases:
        for chunk in c.corpus:
            if chunk.id not in unique_chunks:
                unique_chunks[chunk.id] = chunk

    # 按 source_path 分组
    by_source: dict[str, list[KnowledgeChunkData]] = defaultdict(list)
    for chunk in unique_chunks.values():
        source = chunk.source_path or f"/eval/docs/{chunk.id}.md"
        by_source[source].append(chunk)

    inserted_doc_ids: list[UUID] = []
    chunk_to_doc: dict[str, UUID] = {}

    for source_path, chunk_list in by_source.items():
        doc_uuid = uuid4()
        full_source_path = f"/eval/{prefix_tag}{source_path}"
        file_name = Path(source_path).name or f"{prefix_tag}.md"

        max_page = 1
        for chk in chunk_list:
            if chk.page_numbers:
                max_page = max(max_page, max(chk.page_numbers))

        doc_record = DocumentRecord(
            id=doc_uuid,
            source_path=full_source_path,
            file_name=file_name,
            file_type="markdown",
            file_size=sum(len(c.text.encode("utf-8")) for c in chunk_list),
            file_hash=f"hash_{prefix_tag}_{doc_uuid}",
            page_count=max_page,
        )

        real_doc_id = await upsert_document(pool, doc_record)
        inserted_doc_ids.append(real_doc_id)
        await delete_chunks_by_document(pool, real_doc_id)

        # 构造待插入切块
        db_chunks: list[DocumentChunk] = []
        for idx, chk in enumerate(chunk_list):
            chunk_to_doc[chk.id] = real_doc_id

            # 生成嵌入向量
            emb_out = await embedder.embed_query(chk.text)

            # 将原始 chunk.id 编码入 heading_path，格式形如 "c-sh-1::PostgreSQL 向量存储"
            h_path = f"{chk.id}::{chk.title}"
            c_prefix = chk.title

            db_chunks.append(
                DocumentChunk(
                    chunk_index=idx,
                    page_numbers=chk.page_numbers or [1],
                    heading_path=h_path,
                    context_prefix=c_prefix,
                    raw_text=chk.text,
                    token_count=len(chk.text.split()),
                    dense_embedding=emb_out.dense,
                    sparse_vector=emb_out.sparse,
                )
            )

        await batch_insert_chunks(pool, real_doc_id, db_chunks)

    logger.info(
        f"已成功将 {len(unique_chunks)} 个切块录入 PostgreSQL ({len(inserted_doc_ids)} 份文档)"
    )
    return chunk_to_doc, inserted_doc_ids


async def teardown_knowledge_corpus(
    pool: asyncpg.Pool,
    document_ids: list[UUID],
) -> int:
    """清理评测期间写入的文档与切块，防止污染真实环境。"""
    if not document_ids:
        return 0

    query = "DELETE FROM documents WHERE id = ANY($1::uuid[]);"
    async with pool.acquire() as conn:
        res = await conn.execute(query, document_ids)
        # 形如 "DELETE 3"
        try:
            count = int(res.split(" ")[-1])
        except (IndexError, ValueError):
            count = 0
        logger.info(f"已清理评测文档 {count} 份 (级联删除切块)")
        return count
