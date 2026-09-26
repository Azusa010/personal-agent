"""
Knowledge Update Loop 编排与熔断测试。
"""

from unittest.mock import MagicMock
from uuid import uuid4

from personal_agent.knowledge.proposer import build_diff_op, create_proposal
from personal_agent.knowledge.reviewer import KnowledgeReviewer
from personal_agent.knowledge.update_loop import KnowledgeUpdateLoop
from personal_agent.protocol.models import (
    KnowledgeReviewCritique,
    KnowledgeReviewOutcome,
)


def test_update_loop_approved_in_first_round():
    loop = KnowledgeUpdateLoop()
    ev = uuid4()
    op = build_diff_op("add", "chunk", [ev], payload={"text": "合规知识"})
    proposal = create_proposal("首轮通过提案", "chunk", [op], [ev])

    final_proposal, outcomes = loop.run_review_cycle(proposal, {ev})
    assert final_proposal.status == "approved"
    assert len(outcomes) == 1
    assert outcomes[0].verdict == "approved"


def test_update_loop_rejected_terminates():
    loop = KnowledgeUpdateLoop()
    ev_fake = uuid4()
    op = build_diff_op("add", "chunk", [ev_fake], payload={"text": "虚假"})
    proposal = create_proposal("假证据提案", "chunk", [op], [ev_fake])

    # 证据未注册导致直接拒绝
    mock_reviewer = MagicMock(spec=KnowledgeReviewer)
    mock_reviewer.review.return_value = KnowledgeReviewOutcome(
        proposalId=proposal.id,
        reviewerModel="mock-reviewer",
        verdict="rejected",
        critiques=[
            KnowledgeReviewCritique(
                opIndex=0,
                verdict="reject",
                issueType="lacks_evidence",
                explanation="未通过证据核验",
            )
        ],
        reviewComments="未通过",
        reviewedAt="2026-09-26T00:00:00Z",
    )
    loop.reviewer = mock_reviewer

    final_proposal, outcomes = loop.run_review_cycle(proposal, set())
    assert final_proposal.status == "rejected"
    assert len(outcomes) == 1
    assert outcomes[0].verdict == "rejected"


def test_update_loop_auto_revises_and_approves_in_second_round():
    ev = uuid4()
    op = build_diff_op(
        "modify",
        "chunk",
        [ev],
        payload={"text": "冲突修改", "is_conflict": True},
        qualification=None,
    )
    proposal = create_proposal("需修订提案", "chunk", [op], [ev])

    loop = KnowledgeUpdateLoop(max_iterations=3)

    # 模拟首轮 request_revision，第二轮 approved
    outcome1 = KnowledgeReviewOutcome(
        proposalId=proposal.id,
        reviewerModel="mock-reviewer",
        verdict="revision_requested",
        critiques=[
            KnowledgeReviewCritique(
                opIndex=0,
                verdict="revise",
                issueType="missing_qualification",
                explanation="缺少适用场景限定",
                requiredCorrection="在自首且积极赔偿时适用",
            )
        ],
        reviewComments="需修订",
        reviewedAt="2026-09-26T00:00:00Z",
    )
    outcome2 = KnowledgeReviewOutcome(
        proposalId=proposal.id,
        reviewerModel="mock-reviewer",
        verdict="approved",
        critiques=[
            KnowledgeReviewCritique(
                opIndex=0, verdict="pass", explanation="通过"
            )
        ],
        reviewComments="修订满意，批准",
        reviewedAt="2026-09-26T00:01:00Z",
    )

    mock_reviewer = MagicMock(spec=KnowledgeReviewer)
    mock_reviewer.review.side_effect = [outcome1, outcome2]
    loop.reviewer = mock_reviewer

    final_proposal, outcomes = loop.run_review_cycle(proposal, {ev})
    assert len(outcomes) == 2
    assert final_proposal.status == "approved"
    assert final_proposal.iterationCount == 2
    # 验证修订器自动补充了 qualification
    assert (
        final_proposal.operations[0].qualification
        == "在自首且积极赔偿时适用"
    )


def test_update_loop_circuit_breaker_after_max_iterations():
    ev = uuid4()
    op = build_diff_op("modify", "chunk", [ev], payload={"text": "一直有争议"})
    proposal = create_proposal("争议提案", "chunk", [op], [ev])

    loop = KnowledgeUpdateLoop(max_iterations=3)

    # 模拟持续返回 revision_requested，故意不让过
    stuck_outcome = KnowledgeReviewOutcome(
        proposalId=proposal.id,
        reviewerModel="mock-reviewer",
        verdict="revision_requested",
        critiques=[
            KnowledgeReviewCritique(
                opIndex=0,
                verdict="revise",
                issueType="missing_qualification",
                explanation="仍不充分",
            )
        ],
        reviewComments="需继续修订",
        reviewedAt="2026-09-26T00:00:00Z",
    )
    mock_reviewer = MagicMock(spec=KnowledgeReviewer)
    mock_reviewer.review.return_value = stuck_outcome
    loop.reviewer = mock_reviewer

    final_proposal, outcomes = loop.run_review_cycle(proposal, {ev})
    assert len(outcomes) == 3
    # 达到 3 轮上限，熔断降级为 rejected
    assert final_proposal.status == "rejected"
