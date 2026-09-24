"""知识库神经重排序器单元测试。"""

import asyncio

from personal_agent.knowledge.reranker import (
    BaseReranker,
    BgeReranker,
    MockReranker,
    ScoredChunk,
    get_reranker,
)


def _make_candidate(chunk_id: str, text: str, rrf_score: float) -> ScoredChunk:
    return ScoredChunk(
        id=chunk_id,
        document_id="doc-1",
        file_name="test.md",
        source_path="/test.md",
        chunk_index=0,
        page_numbers=[1],
        raw_text=text,
        rrf_score=rrf_score,
        score=rrf_score,
    )


def test_mock_reranker_sorting_and_top_k():
    """验证 MockReranker 按 rrf_score 降序精排并精准截断 top_k。"""

    async def _run():
        reranker = MockReranker()
        candidates = [
            _make_candidate("c-low", "低相关文档", 0.012),
            _make_candidate("c-high", "高相关文档", 0.035),
            _make_candidate("c-mid", "中等相关文档", 0.024),
        ]

        # 请求 top_k = 2
        results = await reranker.rerank("测试查询", candidates, top_k=2)

        assert len(results) == 2
        assert results[0].id == "c-high"
        assert results[1].id == "c-mid"
        assert results[0].score >= results[1].score

    asyncio.run(_run())


def test_get_reranker_strategy_dispatch():
    """验证 Reranker 策略工厂分发实例。"""
    mock_inst = get_reranker(mode="mock")
    assert isinstance(mock_inst, MockReranker)

    local_inst = get_reranker(mode="local")
    assert isinstance(local_inst, BgeReranker)
    assert isinstance(local_inst, BaseReranker)
