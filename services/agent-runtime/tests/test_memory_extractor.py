"""用户记忆提炼引擎 (memory_extractor) 单元测试。"""

import asyncio
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from personal_agent.conversation.compression.models import DistilledFact
from personal_agent.knowledge.embedder import EmbeddingOutput
from personal_agent.knowledge.memory_extractor import (
    MemoryExtractor,
    extract_card_from_fact,
    infer_memory_classification,
    is_transient_fact,
)


def test_is_transient_fact():
    """验证瞬时执行细节与低价值日志被成功识别过滤。"""
    transient_fact = DistilledFact(
        subject="tmp_output_file",
        predicate="创建于临时目录",
        object="/tmp/workspace/temp_123.log",
    )
    assert is_transient_fact(transient_fact) is True

    persistent_fact = DistilledFact(
        subject="用户偏好",
        predicate="偏好输出格式",
        object="Markdown 表格样式",
    )
    assert is_transient_fact(persistent_fact) is False


def test_infer_memory_classification():
    """验证从事实语义自动推导认知科学三类记忆与细分类别。"""
    f1 = DistilledFact(subject="饮食习惯", predicate="偏好素食与低糖", object="本人")
    m_type1, cat1 = infer_memory_classification(f1)
    assert m_type1 == "semantic"
    assert cat1 == "preference"

    f2 = DistilledFact(subject="用户职业", predicate="身份为高级架构师", object="本人")
    m_type2, cat2 = infer_memory_classification(f2)
    assert m_type2 == "semantic"
    assert cat2 == "identity"

    f3 = DistilledFact(subject="发票报销流程", predicate="先填写系统表单然后附带凭证", object="公司财务")
    m_type3, cat3 = infer_memory_classification(f3)
    assert m_type3 == "procedural"
    assert cat3 == "routine"

    f4 = DistilledFact(subject="护照到期", predicate="截止日期为 2025-02-18", object="出入境")
    m_type4, cat4 = infer_memory_classification(f4)
    assert m_type4 == "episodic"
    assert cat4 == "general"


def test_extract_card_from_fact_sanitization():
    """验证从事实提炼 Card 时，敏感信息自动被 PII 脱敏并标记 isSanitized。"""
    fact_with_pii = DistilledFact(
        subject="紧急联系人",
        predicate="手机号码为",
        object="13911112222，身份证 11010119900307239X",
    )

    card = extract_card_from_fact(fact_with_pii, task_id="task-pii-test")
    assert card.isSanitized is True
    assert "139****2222" in card.content["object"]
    assert "11010119900307239X" not in card.content["object"]
    assert card.person == "本人"
    assert card.relationship == "本人"


def test_distill_and_append_pure_add():
    """验证 Mem0 v3 纯追加写入：过滤瞬时细节后，全部事实直接执行追加 INSERT。"""
    facts = [
        DistilledFact(
            subject="临时执行进程",
            predicate="pid为",
            object="9527",
        ),  # 瞬时，应过滤
        DistilledFact(
            subject="咖啡偏好",
            predicate="偏好无糖美式",
            object="本人",
        ),
        DistilledFact(
            subject="工作住址",
            predicate="居住于上海浦东",
            object="本人",
        ),
    ]

    mock_pool = MagicMock()
    mock_conn = AsyncMock()
    # fetchval 返回生成的 uuid
    mock_conn.fetchval.return_value = str(uuid4())
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn

    mock_embedder = AsyncMock()
    mock_embedder.embed_query.return_value = EmbeddingOutput(
        dense=[0.1] * 1024,
        sparse={"coffee": 1.0},
    )

    extractor = MemoryExtractor(pool=mock_pool, embedder=mock_embedder)

    async def _run():
        cards = await extractor.distill_and_append(
            task_id="task-add-123",
            facts=facts,
            task_summary="用户画像与偏好确认",
        )
        assert len(cards) == 2
        assert cards[0].subject == "咖啡偏好"
        assert cards[1].subject == "工作住址"
        # 验证插入被执行 2 次
        assert mock_conn.fetchval.call_count == 2
        # 验证每次调用的 SQL 为 INSERT INTO user_memories
        for call_args in mock_conn.fetchval.call_args_list:
            sql = call_args[0][0]
            assert "INSERT INTO user_memories" in sql

    asyncio.run(_run())
