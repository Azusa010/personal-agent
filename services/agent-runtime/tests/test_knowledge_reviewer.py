"""
Knowledge Reviewer 单元测试。
"""

from uuid import uuid4

from personal_agent.knowledge.proposer import build_diff_op, create_proposal
from personal_agent.knowledge.reviewer import KnowledgeReviewer


def test_reviewer_approves_valid_proposal():
    reviewer = KnowledgeReviewer()
    ev1 = uuid4()
    ev2 = uuid4()
    valid_evidence = {ev1, ev2}

    op1 = build_diff_op("add", "chunk", [ev1], payload={"text": "新增合规知识"})
    op2 = build_diff_op(
        "modify",
        "chunk",
        [ev2],
        payload={"text": "修改知识", "is_conflict": True},
        qualification="在特定例外案情下适用",
    )
    proposal = create_proposal("合规提案", "chunk", [op1, op2], [ev1, ev2])

    outcome = reviewer.review(proposal, valid_evidence)
    assert outcome.verdict == "approved"
    assert len(outcome.critiques) == 2
    assert all(c.verdict == "pass" for c in outcome.critiques)


def test_reviewer_rejects_lacks_evidence():
    reviewer = KnowledgeReviewer()
    ev_registered = uuid4()
    ev_fake = uuid4()  # 未在合法证据库中注册

    op = build_diff_op("add", "chunk", [ev_fake], payload={"text": "虚假捏造知识"})
    proposal = create_proposal("假证据提案", "chunk", [op], [ev_fake])

    outcome = reviewer.review(proposal, {ev_registered})
    assert outcome.verdict == "rejected"
    assert outcome.critiques[0].verdict == "reject"
    assert outcome.critiques[0].issueType == "lacks_evidence"
    assert "不在已验证证据库中" in outcome.critiques[0].explanation


def test_reviewer_rejects_over_broad_deletion():
    reviewer = KnowledgeReviewer()
    ev = uuid4()

    # 1. 理由为空
    op_empty_reason = build_diff_op("delete", "memory", [ev], payload={})
    p1 = create_proposal("恶意清空提案", "memory", [op_empty_reason], [ev])
    o1 = reviewer.review(p1, {ev})
    assert o1.verdict == "rejected"
    assert o1.critiques[0].issueType == "over_broad_deletion"

    # 2. 理由太短（< 10 字）
    op_short_reason = build_diff_op(
        "delete", "memory", [ev], payload={"reason": "不要了"}
    )
    p2 = create_proposal("理由过短提案", "memory", [op_short_reason], [ev])
    o2 = reviewer.review(p2, {ev})
    assert o2.verdict == "rejected"
    assert o2.critiques[0].issueType == "over_broad_deletion"


def test_reviewer_requests_revision_on_missing_qualification():
    reviewer = KnowledgeReviewer()
    ev = uuid4()

    # 发生冲突但未声明 qualification
    op_conflict_no_qual = build_diff_op(
        "modify",
        "chunk",
        [ev],
        payload={"text": "覆盖旧知识", "is_conflict": True},
        qualification=None,
    )
    proposal = create_proposal("未限定冲突提案", "chunk", [op_conflict_no_qual], [ev])

    outcome = reviewer.review(proposal, {ev})
    assert outcome.verdict == "revision_requested"
    assert outcome.critiques[0].verdict == "revise"
    assert outcome.critiques[0].issueType == "missing_qualification"
    assert outcome.critiques[0].requiredCorrection is not None
