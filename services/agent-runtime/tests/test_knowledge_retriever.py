"""知识库混合检索器与 RRF 融合单元测试。"""

from personal_agent.knowledge.reranker import ScoredChunk
from personal_agent.knowledge.retriever import clean_fts_query, fuse_rrf


def _make_candidate(chunk_id: str, text: str) -> ScoredChunk:
    return ScoredChunk(
        id=chunk_id,
        document_id="doc-1",
        file_name="test.md",
        source_path="/test.md",
        chunk_index=0,
        page_numbers=[1],
        raw_text=text,
    )


def test_clean_fts_query():
    """验证全文检索查询文本清洗，消除特殊运算符与非法格式。"""
    raw_query = "PersonalAgent & (智能体 | 架构) ! 检索:* \\ test"
    cleaned = clean_fts_query(raw_query)

    assert "&" not in cleaned
    assert "|" not in cleaned
    assert "!" not in cleaned
    assert "(" not in cleaned and ")" not in cleaned
    assert "PersonalAgent 智能体 架构 检索 test" in cleaned

    # 边界测试：纯特殊字符与纯空格
    empty_clean = clean_fts_query("   && || !!  ")
    assert empty_clean == " "


def test_fuse_rrf_scoring_and_ranking():
    """验证 RRF 融合算法：双路同时命中的候选由于累加效应获得更高综合排名。

    场景设定：
    - Candidate A: 稠密检索第 1 名，未在稀疏命中；
    - Candidate B: 稀疏检索第 1 名，未在稠密命中；
    - Candidate C: 稠密第 2 名，且稀疏第 2 名。

    根据理论公式：
    Score(A) = 1/(60+1) ≈ 0.01639
    Score(B) = 1/(60+1) ≈ 0.01639
    Score(C) = 1/(60+2) + 1/(60+2) = 2/62 ≈ 0.03225

    Candidate C 必然排名第 1。
    """
    ca = _make_candidate("ca", "稠密第一")
    cb = _make_candidate("cb", "稀疏第一")
    cc = _make_candidate("cc", "双路第二")

    dense_list = [ca, cc]
    sparse_list = [cb, cc]

    fused = fuse_rrf(dense_list, sparse_list, k=60)

    # 断言列表长度与前三项顺序
    assert len(fused) == 3
    assert fused[0].id == "cc"
    assert fused[0].dense_rank == 2
    assert fused[0].sparse_rank == 2
    assert abs(fused[0].rrf_score - (1 / 62 + 1 / 62)) < 1e-4

    # 检查第二、三名
    other_ids = {fused[1].id, fused[2].id}
    assert other_ids == {"ca", "cb"}


from unittest.mock import AsyncMock, patch

import pytest

from personal_agent.knowledge.retriever import UserMemoryRetriever
from personal_agent.protocol.models import (
    UserMemoryCard,
    UserMemorySearchItem,
    UserMemorySearchParams,
)


@pytest.mark.asyncio
async def test_user_memory_retriever_search_flow():
    """验证 UserMemoryRetriever 能够正确调用 search_memories_hybrid 并打包结果。"""
    mock_card = UserMemoryCard(
        id="c1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
        memoryType="semantic",
        category="preference",
        subject="咖啡习惯",
        content={"favorite": "latte"},
        validFrom="2026-09-20T12:00:00Z",
        createdAt="2026-09-20T12:00:00Z",
        updatedAt="2026-09-24T10:00:00Z",
    )
    mock_items = [
        UserMemorySearchItem(
            card=mock_card,
            score=0.9,
            denseRank=1,
            sparseRank=1,
            matchedText="咖啡习惯: favorite = latte",
        )
    ]

    class FakeEmbedder:
        async def embed_query(self, text: str):
            class Out:
                dense = [0.1] * 1024

            return Out()

    fake_pool = object()
    retriever = UserMemoryRetriever(pool=fake_pool, embedder=FakeEmbedder())

    with patch(
        "personal_agent.knowledge.memory_repository.search_memories_hybrid",
        new_callable=AsyncMock,
    ) as mock_search:
        mock_search.return_value = mock_items

        params = UserMemorySearchParams(query="咖啡", topK=5)
        res = await retriever.search(params)

        assert res.ok is True
        assert res.totalFound == 1
        assert res.query == "咖啡"
        assert len(res.items) == 1
        assert res.items[0].card.subject == "咖啡习惯"
        mock_search.assert_awaited_once_with(
            pool=fake_pool,
            query_text="咖啡",
            dense_vector=[0.1] * 1024,
            params=params,
            limit=5,
        )

