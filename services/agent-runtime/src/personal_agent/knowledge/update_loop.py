"""
知识 PR 更新编排流 (Knowledge Update Loop)。

协调提议者与审核者的多轮协商审查机制。
支持 3 轮协商熔断、防死循环降级与 PR 最终合入状态管理（基于《深入理解 AI Agent》第 3 章 3.5 节）。
"""

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

from personal_agent.knowledge.reviewer import KnowledgeReviewer
from personal_agent.protocol.models import (
    KnowledgeDiffOp,
    KnowledgeProposal,
    KnowledgeReviewOutcome,
)

logger = logging.getLogger(__name__)

DEFAULT_MAX_REVIEW_ITERATIONS = 3


class KnowledgeUpdateLoop:
    """管理 Proposer 与 Reviewer 之间的 PR 审查流转编排器。"""

    def __init__(
        self,
        reviewer: KnowledgeReviewer | None = None,
        max_iterations: int = DEFAULT_MAX_REVIEW_ITERATIONS,
    ) -> None:
        self.reviewer = reviewer or KnowledgeReviewer()
        self.max_iterations = max_iterations

    def run_review_cycle(
        self,
        initial_proposal: KnowledgeProposal,
        available_evidence_ids: set[UUID],
        revision_handler: Callable[
            [KnowledgeProposal, KnowledgeReviewOutcome], KnowledgeProposal
        ]
        | None = None,
    ) -> tuple[KnowledgeProposal, list[KnowledgeReviewOutcome]]:
        """执行多轮协商审查循环，直到 approved、rejected 或达到熔断上限。"""
        current_proposal = initial_proposal
        outcomes: list[KnowledgeReviewOutcome] = []

        while current_proposal.iterationCount <= self.max_iterations:
            outcome = self.reviewer.review(current_proposal, available_evidence_ids)
            outcomes.append(outcome)

            if outcome.verdict == "approved":
                current_proposal.status = "approved"
                current_proposal.updatedAt = datetime.now(UTC).isoformat()
                logger.info(
                    "知识提案 %s 于第 %d 轮审核通过 (approved)",
                    current_proposal.id,
                    current_proposal.iterationCount,
                )
                return current_proposal, outcomes

            if outcome.verdict == "rejected":
                current_proposal.status = "rejected"
                current_proposal.updatedAt = datetime.now(UTC).isoformat()
                logger.warning(
                    "知识提案 %s 于第 %d 轮被拒绝 (rejected): %s",
                    current_proposal.id,
                    current_proposal.iterationCount,
                    outcome.reviewComments,
                )
                return current_proposal, outcomes

            # 此时为 revision_requested
            if current_proposal.iterationCount >= self.max_iterations:
                current_proposal.status = "rejected"
                current_proposal.updatedAt = datetime.now(UTC).isoformat()
                logger.warning(
                    "知识提案 %s 超过最大协商轮次 (%d 轮) 熔断拒绝",
                    current_proposal.id,
                    self.max_iterations,
                )
                return current_proposal, outcomes

            # 触发修订
            if revision_handler is not None:
                current_proposal = revision_handler(current_proposal, outcome)
            else:
                current_proposal = self._default_revision(current_proposal, outcome)

            current_proposal.iterationCount += 1
            current_proposal.status = "reviewing"
            current_proposal.updatedAt = datetime.now(UTC).isoformat()

        return current_proposal, outcomes

    def _default_revision(
        self,
        proposal: KnowledgeProposal,
        outcome: KnowledgeReviewOutcome,
    ) -> KnowledgeProposal:
        """默认修订策略：根据 critique 的建议自动补充场景限定 (qualification)。"""
        new_ops: list[KnowledgeDiffOp] = []
        for idx, op in enumerate(proposal.operations):
            matching_critique = next(
                (
                    c
                    for c in outcome.critiques
                    if c.opIndex == idx and c.verdict == "revise"
                ),
                None,
            )
            if matching_critique and not op.qualification:
                revised_op = op.model_copy(
                    update={
                        "qualification": matching_critique.requiredCorrection
                        or "在特定复合情境或前置事实具备时适用"
                    }
                )
                new_ops.append(revised_op)
            else:
                new_ops.append(op)

        return proposal.model_copy(
            update={
                "operations": new_ops,
                "iterationCount": proposal.iterationCount,
            }
        )
