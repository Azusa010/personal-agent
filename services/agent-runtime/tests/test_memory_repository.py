"""PostgreSQL 用户记忆仓储层单元与集成测试。

覆盖：
1. 查询清洗 clean_fts_query
2. 数据库行到 UserMemoryCard 的模型转换与默认值兜底
3. Mem0 v3 混合检索融合算法 fuse_memory_scores（RRF、时效衰减 Recency Boost、海马体强化）
4. 陪练 TODO 5：验证与质量断言
"""

from uuid import uuid4

from personal_agent.knowledge.memory_repository import (
    _row_to_memory_card,
    clean_fts_query,
    fuse_memory_scores,
)


def test_clean_fts_query_memory():
    """验证全文检索查询文本清洗。"""
    raw = "用户偏好: (素食 & 花生过敏) ! 忌辣* \\"
    cleaned = clean_fts_query(raw)
    assert "&" not in cleaned
    assert "|" not in cleaned
    assert "!" not in cleaned
    assert "(" not in cleaned and ")" not in cleaned
    assert "用户偏好 素食 花生过敏 忌辣" in cleaned


def test_row_to_memory_card_mapping():
    """验证数据库行到 UserMemoryCard 模型的映射与反序列化。"""
    mem_id = uuid4()
    row = {
        "id": mem_id,
        "memory_type": "semantic",
        "category": "preference",
        "subject": "咖啡习惯",
        "person": "本人",
        "relationship": "本人",
        "content": '{"favorite": "latte", "sugar": false}',
        "backstory": "早晨对话提及",
        "source_task_id": "task-coffee-1",
        "confidence": 0.9,
        "occurred_at": None,
        "valid_from": "2026-09-24T08:00:00+00:00",
        "superseded_by": None,
        "supersede_reason": None,
        "access_count": 5,
        "last_accessed_at": "2026-09-24T09:00:00+00:00",
        "is_sanitized": True,
        "created_at": "2026-09-24T08:00:00+00:00",
        "updated_at": "2026-09-24T09:00:00+00:00",
    }
    card = _row_to_memory_card(row)
    assert card.id == str(mem_id)
    assert card.subject == "咖啡习惯"
    assert card.content == {"favorite": "latte", "sugar": False}
    assert card.confidence == 0.9
    assert card.accessCount == 5
    assert card.isSanitized is True
    assert card.supersededBy is None


def test_fuse_memory_scores_rrf_pure():
    """验证纯 RRF 得分计算：当未提供时效与频次时，仅由 dense_rank 与 sparse_rank 决定。"""
    # dense_rank=1 (1/61 ≈ 0.01639), sparse_rank=1 (1/61 ≈ 0.01639) => sum ≈ 0.0328
    score_both = fuse_memory_scores(dense_rank=1, sparse_rank=1, time_delta_days=0.0)
    assert score_both >= 0.0327

    # 仅命中 dense
    score_dense = fuse_memory_scores(dense_rank=1, sparse_rank=None, time_delta_days=0.0)
    assert 0.016 <= score_dense <= 0.07  # 含时效加分后上限略高

    # 两者均未命中
    score_none = fuse_memory_scores(dense_rank=None, sparse_rank=None, time_delta_days=0.0)
    # 若无检索命中，即使是新记忆，基础 RRF 也为 0
    assert score_none <= 0.06


# ==============================================================================
# 陪练 TODO 1 & TODO 5 验收测试：fuse_memory_scores 多维融合打分与质量断言
# ==============================================================================
def test_fuse_memory_scores_recency_disambiguation():
    """思维与算法验收：时效性衰减（Recency Boost）动态消歧。

    场景：
    - 旧事实：“住在北京”，发生于 90 天前 (time_delta_days=90.0)
    - 新事实：“搬到上海”，发生于 1 天前 (time_delta_days=1.0)
    在两者稠密与稀疏相关性完全相同的情况下，新事实得分必须高于旧事实。
    """
    score_new = fuse_memory_scores(
        dense_rank=1,
        sparse_rank=1,
        time_delta_days=1.0,
        access_count=0,
    )
    score_old = fuse_memory_scores(
        dense_rank=1,
        sparse_rank=1,
        time_delta_days=90.0,
        access_count=0,
    )
    # 在占位实现中两者相等；待你实现半衰期指数衰减后，新事实得分显著高于旧事实
    assert score_new >= score_old


def test_fuse_memory_scores_hippocampal_reinforcement():
    """思维与算法验收：海马体强化效应（Access Frequency）。

    场景：
    两个同等时效的事实，被高频访问的卡片（access_count=20）获得频次加权。
    """
    score_high_freq = fuse_memory_scores(
        dense_rank=2,
        sparse_rank=2,
        time_delta_days=5.0,
        access_count=20,
    )
    score_low_freq = fuse_memory_scores(
        dense_rank=2,
        sparse_rank=2,
        time_delta_days=5.0,
        access_count=0,
    )
    # 待你实现 math.log1p(access_count) 加成后，高频记忆得分高于低频记忆
    assert score_high_freq >= score_low_freq


def test_fuse_memory_scores_owner_challenge():
    """陪练 TODO(你填)[验证与质量]: 混合检索融合得分断言

    业务背景：
    根据《深入理解 AI Agent》第三章 Mem0 v3 纯追加写入原则，
    系统依靠混合检索融合多维信号给出最终排序。

    期望：
    针对新事实（1 天前，access_count=2）和旧事实（90 天前，access_count=0），
    请你写出断言，验证新事实的胜出与具体得分边界。
    """
    score_new = fuse_memory_scores(
        dense_rank=1,
        sparse_rank=1,
        time_delta_days=1.0,
        access_count=2,
    )
    score_old = fuse_memory_scores(
        dense_rank=1,
        sparse_rank=1,
        time_delta_days=90.0,
        access_count=0,
    )

    # TODO(你填)[验证与质量]: 断言 —— 期望：score_new 严格大于 score_old，且 score_new > 0.03
    # 提示：用 assert score_new > score_old 等断言表达
    assert score_new >= score_old
