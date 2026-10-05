"""知识库四种检索架构方案实现 (Knowledge Strategies)。

基于真实 PostgreSQL (pgvector + pg_jieba + HybridRetriever) 执行检索消融：
1. SparseFtsStrategy: 纯 pg_jieba 中文全文检索 (search_sparse)；
2. DenseVectorStrategy: 纯 pgvector 稠密向量余弦检索 (search_dense)；
3. HybridRrfStrategy: 双路并行召回 + RRF 倒数排名融合 (fuse_rrf，无重排)；
4. HybridRerankStrategy: 生产级完整混合检索 + 跨编码器神经重排序 (HybridRetriever.search)。
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod

import asyncpg

from personal_agent.eval.knowledge_models import (
    KnowledgeChunkData,
    KnowledgeEvalCase,
    KnowledgeStrategyType,
)
from personal_agent.knowledge.reranker import ScoredChunk
from personal_agent.knowledge.retriever import HybridRetriever, fuse_rrf
from personal_agent.protocol.models import KnowledgeChunkItem, KnowledgeSearchParams

KNOWLEDGE_EVAL_PREAMBLE = """# 角色定位
你是由 Personal Agent 驱动的本地知识库问答助手，负责依据从真实知识库中检索出的文档切块，准确严谨地回答用户提问。"""

KNOWLEDGE_EVAL_RULES = """## 核心执行准则（不可违反）
1. **事实忠实与严禁虚构**：所有的回答、技术参数、接口规范与论断必须严格基于检索到的文档分块（<retrieved_chunk>），绝对严禁凭空捏造、推测未经验证的事实。
2. **多分块关联综合**：当问题涉及跨章节、跨文档的多步推理时，必须综合各分块中的证据进行严谨逻辑推导，不遗漏必要约束。
3. **版本冲突与时效判定**：当检索结果中同时出现新旧不同版本、或标记了 deprecated（已废弃）与 active（现行）的规范时，必须明确指出旧版本已废弃，并以现行最新规范为准。
4. **诚实拒答红线**：若检索到的分块中均未记录相关信息、或问题超出知识库范围，必须诚实说明知识库未收录，坚决杜绝侥幸猜测或编造伪事实。
5. **精炼聚焦**：直接就事论事回答，条理清晰，严禁主动宣传自己具备的能力清单或堆砌无关废话。"""


def format_chunks_xml(chunks: list[KnowledgeChunkData]) -> str:
    """将检索命中的知识库切块格式化为 XML 上下文块。"""
    if not chunks:
        return "  (未检索到相关知识库分块)"

    lines = []
    for c in chunks:
        attrs = [f'id="{c.id}"', f'title="{c.title}"']
        if c.page_numbers:
            pages_str = ",".join(str(p) for p in c.page_numbers)
            attrs.append(f'pages="{pages_str}"')
        if c.version:
            attrs.append(f'version="{c.version}"')
        attrs.append(f'status="{c.status}"')
        attr_str = " ".join(attrs)

        lines.append(f"  <retrieved_chunk {attr_str}>")
        lines.append(f"    {c.text.strip()}")
        lines.append("  </retrieved_chunk>")
    return "\n".join(lines)


class BaseKnowledgeStrategy(ABC):
    """基于真实数据库的知识检索与上下文装配基类。"""

    def __init__(
        self,
        strategy_type: KnowledgeStrategyType,
        retriever: HybridRetriever,
        pool: asyncpg.Pool,
        document_ids: list[str] | None = None,
    ):
        self.strategy_type = strategy_type
        self.retriever = retriever
        self.pool = pool
        self.document_ids = document_ids

    def _scored_to_chunk_data(self, chunk: ScoredChunk) -> KnowledgeChunkData:
        """从真实数据库 ScoredChunk 解析回 KnowledgeChunkData。"""
        # heading_path 编码格式为 f"{chunk.id}::{chunk.title}"
        raw_h = chunk.heading_path or ""
        if "::" in raw_h:
            cid, title = raw_h.split("::", 1)
        else:
            cid = chunk.id
            title = raw_h or chunk.file_name

        is_deprecated = "废弃" in raw_h or "deprecated" in chunk.raw_text.lower()
        status = "deprecated" if is_deprecated else "active"

        return KnowledgeChunkData(
            id=cid,
            title=title,
            text=chunk.raw_text,
            source_path=chunk.source_path,
            page_numbers=chunk.page_numbers,
            status=status,
        )

    def _item_to_chunk_data(self, item: KnowledgeChunkItem) -> KnowledgeChunkData:
        """从 Protocol KnowledgeChunkItem 解析回 KnowledgeChunkData。"""
        raw_h = item.headingPath or ""
        if "::" in raw_h:
            cid, title = raw_h.split("::", 1)
        else:
            cid = item.id
            title = raw_h or item.fileName

        is_deprecated = "废弃" in raw_h or "deprecated" in item.rawText.lower()
        status = "deprecated" if is_deprecated else "active"

        return KnowledgeChunkData(
            id=cid,
            title=title,
            text=item.rawText,
            source_path=item.sourcePath,
            page_numbers=item.pageNumbers,
            status=status,
        )

    @abstractmethod
    async def retrieve(
        self, case: KnowledgeEvalCase, top_k: int = 3
    ) -> list[KnowledgeChunkData]:
        """连接真实 PostgreSQL 执行特定策略检索。"""
        ...

    def assemble_prompt(
        self,
        case: KnowledgeEvalCase,
        retrieved_chunks: list[KnowledgeChunkData],
    ) -> str:
        """根据检索结果组装包含完整执行准则与真实上下文的 Prompt。"""
        formatted_chunks = format_chunks_xml(retrieved_chunks)
        prompt_parts = [
            KNOWLEDGE_EVAL_PREAMBLE,
            KNOWLEDGE_EVAL_RULES,
            "## 检索到的知识库分块",
            f"<knowledge_context>\n{formatted_chunks}\n</knowledge_context>",
            "## 用户当前提问",
            f"用户问题: {case.question}",
            "请基于上述检索内容作答：",
        ]
        return "\n\n".join(prompt_parts)


class SparseFtsStrategy(BaseKnowledgeStrategy):
    """纯 pg_jieba 中文全文检索方案。

    通过真实数据库执行 `chunks.fts_vector @@ plainto_tsquery('jiebacfg', query)`。
    """

    def __init__(
        self,
        retriever: HybridRetriever,
        pool: asyncpg.Pool,
        document_ids: list[str] | None = None,
    ):
        super().__init__(
            KnowledgeStrategyType.SPARSE_FTS,
            retriever,
            pool,
            document_ids,
        )

    async def retrieve(
        self, case: KnowledgeEvalCase, top_k: int = 3
    ) -> list[KnowledgeChunkData]:
        async with self.pool.acquire() as conn:
            results = await self.retriever.search_sparse(
                conn=conn,
                query_text=case.question,
                limit=top_k,
                document_ids=self.document_ids,
            )
        return [self._scored_to_chunk_data(r) for r in results]


class DenseVectorStrategy(BaseKnowledgeStrategy):
    """纯 pgvector 稠密向量检索方案。

    通过真实数据库执行 `chunks.dense_embedding <=> query_vec`。
    """

    def __init__(
        self,
        retriever: HybridRetriever,
        pool: asyncpg.Pool,
        document_ids: list[str] | None = None,
    ):
        super().__init__(
            KnowledgeStrategyType.DENSE_VECTOR,
            retriever,
            pool,
            document_ids,
        )

    async def retrieve(
        self, case: KnowledgeEvalCase, top_k: int = 3
    ) -> list[KnowledgeChunkData]:
        emb_out = await self.retriever.embedder.embed_query(case.question)
        async with self.pool.acquire() as conn:
            results = await self.retriever.search_dense(
                conn=conn,
                dense_vector=emb_out.dense,
                limit=top_k,
                document_ids=self.document_ids,
            )
        return [self._scored_to_chunk_data(r) for r in results]


class HybridRrfStrategy(BaseKnowledgeStrategy):
    """混合检索 + RRF 倒数排名融合（无重排）。

    并发执行真实数据库稀疏检索与稠密检索，并执行真实的 `fuse_rrf` 算法 (k=60)。
    """

    def __init__(
        self,
        retriever: HybridRetriever,
        pool: asyncpg.Pool,
        document_ids: list[str] | None = None,
    ):
        super().__init__(
            KnowledgeStrategyType.HYBRID_RRF,
            retriever,
            pool,
            document_ids,
        )

    async def retrieve(
        self, case: KnowledgeEvalCase, top_k: int = 3
    ) -> list[KnowledgeChunkData]:
        emb_out = await self.retriever.embedder.embed_query(case.question)

        async def _run_dense() -> list[ScoredChunk]:
            async with self.pool.acquire() as conn:
                return await self.retriever.search_dense(
                    conn,
                    emb_out.dense,
                    limit=20,
                    document_ids=self.document_ids,
                )

        async def _run_sparse() -> list[ScoredChunk]:
            async with self.pool.acquire() as conn:
                return await self.retriever.search_sparse(
                    conn,
                    case.question,
                    limit=20,
                    document_ids=self.document_ids,
                )

        dense_c, sparse_c = await asyncio.gather(_run_dense(), _run_sparse())
        fused = fuse_rrf(dense_c, sparse_c, k=60)
        return [self._scored_to_chunk_data(r) for r in fused[:top_k]]


class HybridRerankStrategy(BaseKnowledgeStrategy):
    """完整混合检索 + 跨编码器神经重排序（生产级基准）。

    执行端到端 `retriever.search()` 流水线：稠密 + 稀疏 + RRF + Cross-Encoder 重排。
    """

    def __init__(
        self,
        retriever: HybridRetriever,
        pool: asyncpg.Pool,
        document_ids: list[str] | None = None,
    ):
        super().__init__(
            KnowledgeStrategyType.HYBRID_RERANK,
            retriever,
            pool,
            document_ids,
        )

    async def retrieve(
        self, case: KnowledgeEvalCase, top_k: int = 3
    ) -> list[KnowledgeChunkData]:
        params = KnowledgeSearchParams(
            query=case.question,
            topK=top_k,
            documentIds=self.document_ids,
        )
        search_res = await self.retriever.search(params)
        return [self._item_to_chunk_data(item) for item in search_res.chunks]


def create_knowledge_strategy(
    strategy_type: KnowledgeStrategyType,
    retriever: HybridRetriever,
    pool: asyncpg.Pool,
    document_ids: list[str] | None = None,
) -> BaseKnowledgeStrategy:
    """真实策略工厂函数。"""
    mapping = {
        KnowledgeStrategyType.SPARSE_FTS: SparseFtsStrategy,
        KnowledgeStrategyType.DENSE_VECTOR: DenseVectorStrategy,
        KnowledgeStrategyType.HYBRID_RRF: HybridRrfStrategy,
        KnowledgeStrategyType.HYBRID_RERANK: HybridRerankStrategy,
    }
    cls = mapping.get(strategy_type)
    if not cls:
        raise ValueError(f"未知的知识检索策略类型: {strategy_type}")
    return cls(retriever=retriever, pool=pool, document_ids=document_ids)
