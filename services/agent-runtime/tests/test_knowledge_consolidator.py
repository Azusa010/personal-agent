"""
Knowledge Consolidator (睡眠学习全量整理器) 单元测试。
"""

from uuid import uuid4

from personal_agent.knowledge.consolidator import KnowledgeConsolidator


def test_deduplicate_entries_merges_references():
    consolidator = KnowledgeConsolidator()
    ev1 = uuid4()
    ev2 = uuid4()

    entries = [
        {
            "id": "e-1",
            "text": "刑法第一百三十三条交通肇事罪",
            "evidenceRefs": [ev1],
        },
        {
            "id": "e-2",
            "text": "刑法第一百三十三条交通肇事罪规定",
            "evidenceRefs": [ev2],
        },
        {"id": "e-3", "text": "民法典第一千一百六十五条侵权责任", "evidenceRefs": []},
    ]

    deduped = consolidator.deduplicate_entries(entries, similarity_threshold=0.7)
    assert len(deduped) == 2
    # e-1 和 e-2 合并，证据包含 ev1 与 ev2
    merged_item = next(d for d in deduped if "交通肇事" in d["text"])
    assert set(merged_item["evidenceRefs"]) == {ev1, ev2}


def test_retrace_and_verify_evidence_isolates_degraded():
    consolidator = KnowledgeConsolidator()
    ev_valid = uuid4()
    ev_expired = uuid4()

    entries = [
        {"id": "e-1", "text": "真实证据知识", "evidenceRefs": [ev_valid]},
        {"id": "e-2", "text": "失真传话知识", "evidenceRefs": [ev_expired]},
        {"id": "e-3", "text": "凭空捏造知识", "evidenceRefs": []},
    ]

    retained, degraded = consolidator.retrace_and_verify_evidence(
        entries, valid_evidence_ids={ev_valid}
    )
    assert len(retained) == 1
    assert retained[0]["id"] == "e-1"
    assert len(degraded) == 2
    assert {d["id"] for d in degraded} == {"e-2", "e-3"}


def test_resolve_conflicts_with_qualification():
    consolidator = KnowledgeConsolidator()
    entries = [
        {"id": "e-1", "text": "常规结论", "is_conflict": False},
        {"id": "e-2", "text": "冲突结论", "is_conflict": True},
    ]
    resolved = consolidator.resolve_conflicts_with_qualification(entries)
    assert len(resolved) == 2
    assert resolved[0].get("qualification") is None
    assert resolved[1].get("qualification") is not None
