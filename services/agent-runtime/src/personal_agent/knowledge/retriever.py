"""PersonalAgent 知识库混合检索器 (Hybrid Retriever)。

包含并行召回（稠密向量 pgvector + 稀疏全文检索 pg_jieba）、
RRF (Reciprocal Rank Fusion) 排名融合算法，以及跨编码器神经重排序精排。
"""

import asyncio
import logging
import re
from typing import Any

import asyncpg

from personal_agent.db.postgres import get_pg_pool
from personal_agent.knowledge.embedder import BaseEmbedder, get_embedder
from personal_agent.knowledge.reranker import BaseReranker, ScoredChunk, get_reranker
from personal_agent.protocol.models import (
    KnowledgeChunkItem,
    KnowledgeSearchParams,
    KnowledgeSearchResult,
)

logger = logging.getLogger(__name__)


def clean_fts_query(query_text: str) -> str:
    """清洗全文检索查询文本，防止特殊字符引发 SQL 报错或无结果。
    """
    cleaned = re.sub(r"[&|!():*<>\\]", " ", query_text)
    return " ".join(cleaned.split()) or " "


def fuse_rrf(
    dense_candidates: list[ScoredChunk],
    sparse_candidates: list[ScoredChunk],
    k: int = 60,
    weight_dense: float = 1.0,
    weight_sparse: float = 1.0,
) -> list[ScoredChunk]:
    """倒数排名融合算法 (Reciprocal Rank Fusion, RRF)。
    """
    by_id : dict[str, ScoredChunk] = {}

    for rank, chunk in enumerate(dense_candidates, start=1):
        score = weight_dense / (k + rank)
        chunk_copy = chunk.model_copy()
        chunk_copy.dense_rank = rank
        chunk_copy.rrf_score = score
        by_id[chunk.id] = chunk_copy

    for rank, chunk in enumerate(sparse_candidates, start=1):
        score = weight_sparse / (k + rank)
        if chunk.id in by_id:
            existing_chunk = by_id[chunk.id]
            existing_chunk.sparse_rank = rank
            existing_chunk.rrf_score += score
        else:
            chunk_copy = chunk.model_copy()
            chunk_copy.sparse_rank = rank
            chunk_copy.rrf_score = score
            by_id[chunk.id] = chunk_copy

    result = list(by_id.values())
    result.sort(key=lambda x: x.rrf_score, reverse=True)
    return result

class HybridRetriever:
    """生产级三阶段混合检索管道。"""

    def __init__(
        self,
        pool: asyncpg.Pool | None = None,
        embedder: BaseEmbedder | None = None,
        reranker: BaseReranker | None = None,
    ):
        self._pool = pool
        self.embedder = embedder or get_embedder()
        self.reranker = reranker or get_reranker()

    async def _get_pool(self) -> asyncpg.Pool:
        if self._pool is None:
            self._pool = await get_pg_pool()
        return self._pool

    async def search_dense(
        self,
        conn: asyncpg.Connection,
        dense_vector: list[float],
        limit: int = 50,
        document_ids: list[str] | None = None,
        file_types: list[str] | None = None,
    ) -> list[ScoredChunk]:
        """第一阶段：pgvector HNSW 余弦距离检索。"""
        # 构建动态过滤条件
        conditions = ["c.dense_embedding IS NOT NULL"]
        params: list[Any] = [dense_vector, limit]

        if document_ids:
            params.append(document_ids)
            conditions.append(f"c.document_id = ANY(${len(params)}::uuid[])")
        if file_types:
            params.append(file_types)
            conditions.append(f"d.file_type = ANY(${len(params)})")

        where_clause = " AND ".join(conditions)
        query = f"""
        SELECT c.id, c.document_id, c.chunk_index, c.page_numbers, c.heading_path,
               c.raw_text, d.file_name, d.source_path,
               1 - (c.dense_embedding <=> $1::vector) AS dense_similarity
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE {where_clause}
        ORDER BY c.dense_embedding <=> $1::vector ASC
        LIMIT $2;
        """
        rows = await conn.fetch(query, *params)
        results: list[ScoredChunk] = []
        for r in rows:
            results.append(
                ScoredChunk(
                    id=str(r["id"]),
                    document_id=str(r["document_id"]),
                    file_name=r["file_name"],
                    source_path=r["source_path"],
                    chunk_index=r["chunk_index"],
                    page_numbers=list(r["page_numbers"] or []),
                    heading_path=r["heading_path"],
                    raw_text=r["raw_text"],
                    score=float(r["dense_similarity"] or 0.0),
                )
            )
        return results

    async def search_sparse(
        self,
        conn: asyncpg.Connection,
        query_text: str,
        limit: int = 50,
        document_ids: list[str] | None = None,
        file_types: list[str] | None = None,
    ) -> list[ScoredChunk]:
        """第一阶段：PostgreSQL FTS + pg_jieba 中文全文检索。"""
        clean_text = clean_fts_query(query_text)
        conditions = ["c.fts_vector @@ plainto_tsquery('jiebacfg', $1)"]
        params: list[Any] = [clean_text, limit]

        if document_ids:
            params.append(document_ids)
            conditions.append(f"c.document_id = ANY(${len(params)}::uuid[])")
        if file_types:
            params.append(file_types)
            conditions.append(f"d.file_type = ANY(${len(params)})")

        where_clause = " AND ".join(conditions)
        query = f"""
        SELECT c.id, c.document_id, c.chunk_index, c.page_numbers, c.heading_path,
               c.raw_text, d.file_name, d.source_path,
               ts_rank_cd(c.fts_vector, plainto_tsquery('jiebacfg', $1)) AS sparse_score
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE {where_clause}
        ORDER BY sparse_score DESC
        LIMIT $2;
        """
        rows = await conn.fetch(query, *params)
        results: list[ScoredChunk] = []
        for r in rows:
            results.append(
                ScoredChunk(
                    id=str(r["id"]),
                    document_id=str(r["document_id"]),
                    file_name=r["file_name"],
                    source_path=r["source_path"],
                    chunk_index=r["chunk_index"],
                    page_numbers=list(r["page_numbers"] or []),
                    heading_path=r["heading_path"],
                    raw_text=r["raw_text"],
                    score=float(r["sparse_score"] or 0.0),
                )
            )
        return results

    async def search(
        self,
        params: KnowledgeSearchParams,
    ) -> KnowledgeSearchResult:
        """执行端到端混合检索流水线。"""
        pool = await self._get_pool()
        dense_limit = params.denseLimit or 50
        sparse_limit = params.sparseLimit or 50

        # 1. 生成查询嵌入向量
        emb_output = await self.embedder.embed_query(params.query)

        # 2. 并行双路召回
        async with pool.acquire() as conn:
            dense_task = self.search_dense(
                conn,
                emb_output.dense,
                limit=dense_limit,
                document_ids=params.documentIds,
                file_types=params.fileTypes,
            )
            sparse_task = self.search_sparse(
                conn,
                params.query,
                limit=sparse_limit,
                document_ids=params.documentIds,
                file_types=params.fileTypes,
            )
            dense_candidates, sparse_candidates = await asyncio.gather(
                dense_task, sparse_task
            )

        # 3. 第二阶段：RRF 倒数排名融合
        fused = fuse_rrf(dense_candidates, sparse_candidates, k=60)

        # 4. 第三阶段：神经重排序精排 Top-N (截取前 30 送入 Reranker)
        top_candidates = fused[:30]
        reranked = await self.reranker.rerank(
            params.query,
            top_candidates,
            top_k=params.topK,
        )

        # 5. 可选阈值过滤
        if params.minScore is not None:
            reranked = [c for c in reranked if c.score >= params.minScore]

        chunk_items = [
            KnowledgeChunkItem(
                id=c.id,
                documentId=c.document_id,
                fileName=c.file_name,
                sourcePath=c.source_path,
                chunkIndex=c.chunk_index,
                pageNumbers=c.page_numbers,
                headingPath=c.heading_path,
                rawText=c.raw_text,
                score=round(c.score, 4),
                denseRank=c.dense_rank,
                sparseRank=c.sparse_rank,
            )
            for c in reranked
        ]

        logger.info(
            "混合检索完成: query='%s', dense_hits=%d, sparse_hits=%d, fused=%d, final=%d",
            params.query,
            len(dense_candidates),
            len(sparse_candidates),
            len(fused),
            len(chunk_items),
        )

        return KnowledgeSearchResult(
            ok=True,
            query=params.query,
            totalFound=len(chunk_items),
            chunks=chunk_items,
        )
