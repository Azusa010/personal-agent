"""
Knowledge Proposer 单元测试。
"""

from uuid import uuid4

import pytest

from personal_agent.knowledge.proposer import (
    build_diff_op,
    build_proposal_from_facts,
    create_proposal,
)


def test_build_diff_op_validation():
    ev_id = uuid4()
    op = build_diff_op(
        op="add",
        target_type="chunk",
        evidence_refs=[ev_id],
        payload={"text": "测试法条事实"},
        qualification="仅限特定案情",
    )
    assert op.op == "ADD"
    assert op.targetType == "document_chunk"
    assert op.evidenceRefs == [ev_id]
    assert op.qualification == "仅限特定案情"

    # 空证据引用必须抛出 ValueError
    with pytest.raises(ValueError, match="evidence_refs 不能为空"):
        build_diff_op("add", "chunk", evidence_refs=[])


def test_create_proposal_defaults():
    ev_id = uuid4()
    op = build_diff_op("add", "memory", [ev_id], payload={"text": "记忆"})
    proposal = create_proposal("新增记忆提案", "memory", [op], [ev_id])
    assert proposal.title == "新增记忆提案"
    assert proposal.status == "pending"
    assert proposal.iterationCount == 1
    assert len(proposal.operations) == 1
    assert proposal.evidenceIds == [ev_id]


def test_build_proposal_from_facts_success():
    ev1 = uuid4()
    ev2 = uuid4()
    target_item_id = uuid4()

    facts = [
        {"text": "基本构成要件", "op": "add", "evidenceRefs": [ev1]},
        {
            "text": "修改量刑幅度",
            "op": "modify",
            "targetId": str(target_item_id),
            "evidenceRefs": [ev2],
            "qualification": "在自首且立功情形下",
        },
    ]

    proposal = build_proposal_from_facts(
        title="刑法量刑更新 PR",
        target_layer="chunk",
        facts=facts,
        evidence_ids=[ev1, ev2],
    )

    assert len(proposal.operations) == 2
    assert proposal.operations[0].op == "ADD"
    assert proposal.operations[0].evidenceRefs == [ev1]
    assert proposal.operations[1].op == "UPDATE"
    assert proposal.operations[1].targetId == target_item_id
    assert proposal.operations[1].qualification == "在自首且立功情形下"


def test_build_proposal_from_facts_empty_raises():
    ev = uuid4()
    with pytest.raises(ValueError, match="facts 列表不能为空"):
        build_proposal_from_facts("空事实", "chunk", [], [ev])

    with pytest.raises(ValueError, match="evidence_ids 列表不能为空"):
        build_proposal_from_facts("无证据", "chunk", [{"text": "事实"}], [])
