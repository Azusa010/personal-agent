"""阶段 1 测试：5W1H 语义完整性守卫与提炼事实数据模型校验。"""

import pytest
from pydantic import ValidationError

from personal_agent.conversation.compression.invariants import (
    validate_semantic_integrity,
)
from personal_agent.conversation.compression.models import (
    DistilledFact,
    DistilledObservation,
    LifecycleTier,
    TaskType,
)


def test_models_task_type_and_lifecycle_tier_enums():
    """验证任务类型与生命周期枚举值符合设计规范。"""
    assert TaskType.RETRIEVAL.value == "retrieval"
    assert TaskType.ANALYTICAL.value == "analytical"
    assert TaskType.CREATIVE.value == "creative"

    assert LifecycleTier.EPHEMERAL_L0.value == "ephemeral_l0"
    assert LifecycleTier.TASK_SCOPED_L1.value == "task_scoped_l1"
    assert LifecycleTier.PERSISTENT_L2.value == "persistent_l2"


def test_distilled_fact_model_validation():
    """验证 DistilledFact 模型字段与约束。"""
    fact = DistilledFact(
        subject="Ilya Sutskever",
        predicate="离开",
        object="OpenAI",
        temporal="2024年5月",
        pageRefs=[3],
    )
    assert fact.subject == "Ilya Sutskever"
    assert fact.predicate == "离开"
    assert fact.object == "OpenAI"
    assert fact.temporal == "2024年5月"
    assert fact.pageRefs == [3]

    # 空 subject 或 predicate 必须被模型拒绝
    with pytest.raises(ValidationError):
        DistilledFact(subject="", predicate="离开", object="OpenAI")

    with pytest.raises(ValidationError):
        DistilledFact(subject="Ilya Sutskever", predicate="", object="OpenAI")


def test_distilled_observation_model():
    """验证 DistilledObservation 承接调用标识与事实列表。"""
    obs = DistilledObservation(
        callId="call-1",
        capability="document_extract_pdf",
        ok=True,
        tier=LifecycleTier.TASK_SCOPED_L1,
        summary="提取到联合创始人离职信息",
        facts=[
            DistilledFact(
                subject="Ilya Sutskever",
                predicate="离开",
                object="OpenAI",
                temporal="2024年5月",
            )
        ],
        originalChars=2500,
        distilledChars=180,
    )
    assert obs.callId == "call-1"
    assert obs.compression_ratio == pytest.approx(0.928, abs=0.01)


def test_semantic_integrity_accepts_complete_fact():
    """正例：包含主体、动作、客体与时间锚点的完整事实应通过检验。"""
    fact = DistilledFact(
        subject="Ilya Sutskever",
        predicate="离开",
        object="OpenAI",
        temporal="2024年5月",
    )
    valid, reason = validate_semantic_integrity(fact)
    assert valid is True
    assert reason == "ok"


def test_semantic_integrity_rejects_missing_temporal_and_object():
    """反例：'Sutskever 离开' 丢失了关键客体（OpenAI）与时间锚点，必须被拒绝。"""
    bad_fact = DistilledFact(
        subject="Ilya Sutskever",
        predicate="离开",
        object="",
        temporal=None,
    )
    valid, reason = validate_semantic_integrity(bad_fact)
    assert valid is False
    assert "缺少时间锚点" in reason or "缺少关联客体" in reason


def test_semantic_integrity_requires_object_or_qualifier_for_transitive_action():
    """及物动作或状态变动必须有明确客体或限定环境，不可悬空。"""
    incomplete_fact = DistilledFact(
        subject="OpenAI",
        predicate="成立",
        object="",
        temporal="2015年12月",
    )
    valid, reason = validate_semantic_integrity(incomplete_fact)
    assert valid is False
    assert "客体" in reason
