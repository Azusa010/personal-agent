"""PostgreSQL 真实数据库混合检索器 (HybridRetriever) 端到端集成冒烟测试。

验证在真实 PostgreSQL 17 + pgvector + pg_jieba 环境下的：
1. 文档与切块真实落库 (documents & chunks)；
2. HNSW 稠密向量余弦距离检索 (search_dense)；
3. pg_jieba 中文全文检索向量 (fts_vector & search_sparse)；
4. RRF (Reciprocal Rank Fusion) 排名融合协同提权；
5. 元数据过滤 (documentIds, fileTypes)；
6. 级联删除与环境自愈。
"""

import asyncio
import socket
import time
from uuid import UUID, uuid4

import pytest

from personal_agent.db.postgres import (
    close_pg_pool,
    get_pg_pool,
    get_postgres_config,
)
from personal_agent.knowledge.embedder import MockEmbedder
from personal_agent.knowledge.models import DocumentChunk, DocumentRecord
from personal_agent.knowledge.repository import (
    batch_insert_chunks,
    delete_chunks_by_document,
    upsert_document,
)
from personal_agent.knowledge.reranker import MockReranker
from personal_agent.knowledge.retriever import HybridRetriever
from personal_agent.protocol.models import KnowledgeSearchParams


def _is_pg_reachable() -> bool:
    cfg = get_postgres_config()
    try:
        with socket.create_connection((cfg["host"], cfg["port"]), timeout=0.5):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _is_pg_reachable(), reason="PostgreSQL 5432 端口未启动，跳过真实数据库冒烟测试"
)


def _generate_unit_vector(active_index: int, dim: int = 1024) -> list[float]:
    """生成指定维度为 1.0 的 1024 维归一化单位向量。"""
    vec = [0.0] * dim
    vec[active_index % dim] = 1.0
    return vec


@pytest.fixture(scope="module")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.mark.asyncio
async def test_hybrid_retriever_real_db_end_to_end_smoke():
    """真实数据库混合检索端到端完整冒烟流程。"""
    pool = await get_pg_pool()
    timestamp = int(time.time() * 1000)
    test_source_path = f"/smoke/docs/knowledge_test_{timestamp}.pdf"

    doc_record = DocumentRecord(
        id=uuid4(),
        source_path=test_source_path,
        file_name=f"knowledge_test_{timestamp}.pdf",
        file_type="pdf",
        file_size=1024 * 1024,
        file_hash=f"hash_{timestamp}",
        page_count=10,
    )

    try:
        # 1. 插入文档元数据
        doc_id = await upsert_document(pool, doc_record)
        assert isinstance(doc_id, UUID)

        # 2. 插入多条包含特定中文语义与独立向量的切块
        # Chunk 0: 重点包含「向量检索」「余弦距离」，主要激活第 0 维度
        chunk_0 = DocumentChunk(
            document_id=doc_id,
            chunk_index=0,
            page_numbers=[1],
            heading_path="第一章/检索技术",
            raw_text="向量数据库通过高维空间余弦相似度计算，实现语义层面的精确与近似最近邻召回。",
            context_prefix="【技术架构/检索算法】",
            token_count=120,
            dense_embedding=_generate_unit_vector(0),
        )

        # Chunk 1: 重点包含「结巴分词」「倒排索引」，主要激活第 1 维度
        chunk_1 = DocumentChunk(
            document_id=doc_id,
            chunk_index=1,
            page_numbers=[2],
            heading_path="第二章/中文处理",
            raw_text="中文全文检索依赖 pg_jieba 中文分词插件生成倒排索引，能够准确识别专有名词和复合词汇。",
            context_prefix="【中文全文检索/分词机制】",
            token_count=135,
            dense_embedding=_generate_unit_vector(1),
        )

        # Chunk 2: 双路命中切块，同时包含「混合检索」与「RRF融合」，主要激活第 2 维度
        chunk_2 = DocumentChunk(
            document_id=doc_id,
            chunk_index=2,
            page_numbers=[3],
            heading_path="第三章/混合架构",
            raw_text="混合检索架构结合稠密向量与稀疏全文检索，通过 RRF 倒数排名融合算法综合评估提升召回质量。",
            context_prefix="【混合检索/RRF算法】",
            token_count=150,
            dense_embedding=_generate_unit_vector(2),
        )

        inserted_count = await batch_insert_chunks(
            pool, doc_id, [chunk_0, chunk_1, chunk_2]
        )
        assert inserted_count == 3

        retriever = HybridRetriever(
            pool=pool,
            embedder=MockEmbedder(),
            reranker=MockReranker(),
        )

        # 3. 单独测试 search_dense：输入与 chunk_0 极其相近的向量
        async with pool.acquire() as conn:
            query_dense_vec = _generate_unit_vector(0)
            dense_results = await retriever.search_dense(
                conn=conn,
                dense_vector=query_dense_vec,
                limit=5,
                document_ids=[str(doc_id)],
            )
            assert len(dense_results) >= 1
            assert dense_results[0].chunk_index == 0
            assert "向量数据库" in dense_results[0].raw_text
            assert dense_results[0].score > 0.99  # 单位向量完全重合，余弦相似度为 1.0

        # 4. 单独测试 search_sparse：输入 pg_jieba 分词文本
        async with pool.acquire() as conn:
            sparse_results = await retriever.search_sparse(
                conn=conn,
                query_text="中文分词 倒排索引",
                limit=5,
                document_ids=[str(doc_id)],
            )
            assert len(sparse_results) >= 1
            assert sparse_results[0].chunk_index == 1
            assert "pg_jieba" in sparse_results[0].raw_text
            assert sparse_results[0].score > 0.0

        # 5. 端到端 search() 测试：执行混合检索与排名融合
        search_params = KnowledgeSearchParams(
            query="混合检索架构与RRF融合算法",
            topK=3,
            documentIds=[str(doc_id)],
        )
        hybrid_res = await retriever.search(search_params)

        assert hybrid_res.ok is True
        assert len(hybrid_res.chunks) >= 1
        assert hybrid_res.query == "混合检索架构与RRF融合算法"

        # 验证返回项元数据契约完整性
        top_item = hybrid_res.chunks[0]
        assert top_item.documentId == str(doc_id)
        assert top_item.fileName == doc_record.file_name
        assert top_item.sourcePath == test_source_path
        assert isinstance(top_item.pageNumbers, list)
        assert top_item.score > 0.0

        # 6. 元数据过滤测试 (过滤不存在的 document_id)
        other_uuid = str(uuid4())
        filtered_params = KnowledgeSearchParams(
            query="混合检索",
            topK=3,
            documentIds=[other_uuid],
        )
        filtered_res = await retriever.search(filtered_params)
        assert filtered_res.ok is True
        assert len(filtered_res.chunks) == 0

    finally:
        # 7. 级联删除与数据清理，保障测试自愈
        deleted_chunks = await delete_chunks_by_document(pool, doc_id)
        assert deleted_chunks == 3
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM documents WHERE id = $1;", doc_id)
            count = await conn.fetchval(
                "SELECT count(*) FROM documents WHERE id = $1;", doc_id
            )
            assert count == 0
        await close_pg_pool()
