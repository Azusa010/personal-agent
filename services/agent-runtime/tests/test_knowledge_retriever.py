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
