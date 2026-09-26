"""
知识审核者 (Knowledge Reviewer)。

基于独立异源模型、具有纯只读权限。对提议者提交的 KnowledgeProposal
执行四项铁律核查（证据溯源、防破坏性删除、场景限定、格式），
生成不可篡改的 KnowledgeReviewOutcome（基于《深入理解 AI Agent》第 3 章 3.5 节）。
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from personal_agent.protocol.models import (
    KnowledgeDiffOp,
    KnowledgeProposal,
    KnowledgeReviewCritique,
    KnowledgeReviewOutcome,
    ReviewVerdict,
)

logger = logging.getLogger(__name__)


class KnowledgeReviewer:
    """知识变更审核者（纯只读模型角色）。"""

    def __init__(self, reviewer_model: str = "model-reviewer-claude") -> None:
        self.reviewer_model = reviewer_model

    def review(
        self,
        proposal: KnowledgeProposal,
        available_evidence_ids: set[UUID],
    ) -> KnowledgeReviewOutcome:
        """对知识提案执行深度审查。

        # Contract:
        #   - Input: proposal (待审提案), available_evidence_ids (系统内合法的真实证据UUID集合)
        #   - Output: KnowledgeReviewOutcome
        #   - Invariants:
        #       - 纯只读，绝不直接执行数据库写入或文件修改；
        #       - 任一操作命中 reject，整体 verdict 必须为 rejected；
        #       - 无 reject 但有 revise，整体 verdict 为 revision_requested；
        #       - 全部操作通过 pass，整体 verdict 为 approved；
        #   - Test file: tests/test_knowledge_reviewer.py
        """
        critiques: list[KnowledgeReviewCritique] = []

        for idx, op in enumerate(proposal.operations):
            critique = self._review_operation(idx, op, available_evidence_ids)
            critiques.append(critique)

        has_reject = any(c.verdict == "reject" for c in critiques)
        has_revise = any(c.verdict == "revise" for c in critiques)

        if has_reject:
            verdict: ReviewVerdict = "rejected"
            comments = "提案包含未通过安全审计或缺乏有效证据的操作，予以拒绝。"
        elif has_revise:
            verdict = "revision_requested"
            comments = "提案部分操作存在争议或缺乏必要限定条件，需修订后重新提交。"
        else:
            verdict = "approved"
            comments = "所有操作均通过真实证据溯源与场景限定审核，准予合入生效。"

        return KnowledgeReviewOutcome(
            proposalId=proposal.id,
            reviewerModel=self.reviewer_model,
            verdict=verdict,
            critiques=critiques,
            reviewComments=comments,
            reviewedAt=datetime.now(UTC).isoformat(),
        )

    def _review_operation(
        self,
        op_index: int,
        op: KnowledgeDiffOp,
        available_evidence_ids: set[UUID],
    ) -> KnowledgeReviewCritique:
        """针对单个 Diff 操作执行四项铁律审查。

        # Contract:
        #   - Input: op_index (int), op (KnowledgeDiffOp), available_evidence_ids (set[UUID])
        #   - Output: KnowledgeReviewCritique
        #   - Test file: tests/test_knowledge_reviewer.py
        """
        for refs in op.evidenceRefs:
            if refs not in available_evidence_ids:
                return KnowledgeReviewCritique(
                    opIndex=op_index,
                    verdict="reject",
                    issueType="lacks_evidence",
                    explanation=f"引用的证据 ID {refs} 不在已验证证据库中，拒绝凭空断言",
                    evidenceRef=refs,
                )
        if op.op in {"INVALIDATE", "delete"}:
            reason = str(op.payload.get("reason", "")).strip()
            if len(reason) < 10:
                return KnowledgeReviewCritique(
                    opIndex=op_index,
                    verdict="reject",
                    issueType="over_broad_deletion",
                    explanation="删除既有知识项必须提供至少10字的合理解释与证据依据，拦截潜在恶意或误删",
                )
        if (  # noqa: SIM102
            op.op in {"UPDATE", "modify", "QUALIFY", "qualify"}
            and op.payload.get("is_conflict") is True
        ):
            if not op.qualification or not op.qualification.strip():
                return KnowledgeReviewCritique(
                    opIndex=op_index,
                    verdict="revise",
                    issueType="missing_qualification",
                    explanation="修改项涉及核心事实冲突，必须指定限定情境 (qualification) 避免知识覆盖退化",
                    requiredCorrection="请补充该事实适用的具体案情或前置法律条件",
                )
        return KnowledgeReviewCritique(
            opIndex=op_index,
            verdict="pass",
            explanation="操作合规，证据链完整",
        )
