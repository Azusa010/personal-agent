"""
知识提议者 (Knowledge Proposer)。

负责从对话交互和提取事实中构建具有严格证据引用的知识变更提案 (KnowledgeProposal)，
生成增量 Diff 操作集合（基于《深入理解 AI Agent》第 3 章 3.5 节）。
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from personal_agent.protocol.models import (
    KnowledgeDiffOp,
    KnowledgeDiffOpType,
    KnowledgeProposal,
    KnowledgeTargetType,
)

OP_MAP: dict[str, KnowledgeDiffOpType] = {
    "add": "ADD",
    "ADD": "ADD",
    "modify": "UPDATE",
    "update": "UPDATE",
    "UPDATE": "UPDATE",
    "delete": "INVALIDATE",
    "invalidate": "INVALIDATE",
    "INVALIDATE": "INVALIDATE",
    "qualify": "QUALIFY",
    "QUALIFY": "QUALIFY",
}

TARGET_MAP: dict[str, KnowledgeTargetType] = {
    "memory": "user_memory",
    "user_memory": "user_memory",
    "chunk": "document_chunk",
    "document_chunk": "document_chunk",
    "viking": "viking_wiki",
    "viking_wiki": "viking_wiki",
}


def build_diff_op(
    op: KnowledgeDiffOpType | str,
    target_type: KnowledgeTargetType | str,
    evidence_refs: list[UUID],
    target_id: UUID | None = None,
    payload: dict[str, Any] | None = None,
    qualification: str | None = None,
) -> KnowledgeDiffOp:
    """构建单个合规的 KnowledgeDiffOp 操作项。"""
    if not evidence_refs:
        raise ValueError("evidence_refs 不能为空，每个操作必须至少具备一条证据引用")

    normalized_op = OP_MAP.get(op, "ADD")
    normalized_target = TARGET_MAP.get(target_type, "document_chunk")

    return KnowledgeDiffOp(
        op=normalized_op,
        targetType=normalized_target,
        targetId=target_id,
        payload=payload or {},
        evidenceRefs=evidence_refs,
        qualification=qualification,
    )


def create_proposal(
    title: str,
    target_layer: KnowledgeTargetType | str,
    operations: list[KnowledgeDiffOp],
    evidence_ids: list[UUID],
    proposer_model: str = "model-proposer-gpt4o",
    proposal_id: UUID | None = None,
) -> KnowledgeProposal:
    """组装初始状态为 pending 的 KnowledgeProposal。"""
    now = datetime.now(UTC).isoformat()
    normalized_target = TARGET_MAP.get(target_layer, "document_chunk")
    return KnowledgeProposal(
        id=proposal_id or uuid4(),
        title=title,
        targetLayer=normalized_target,
        proposerModel=proposer_model,
        operations=operations,
        evidenceIds=evidence_ids,
        status="pending",
        iterationCount=1,
        createdAt=now,
        updatedAt=now,
    )


def build_proposal_from_facts(
    title: str,
    target_layer: KnowledgeTargetType,
    facts: list[dict[str, Any]],
    evidence_ids: list[UUID],
    proposer_model: str = "model-proposer-gpt4o",
) -> KnowledgeProposal:
    """根据提取的一组结构化事实构建完整的 KnowledgeProposal。

    # Contract:
    #   - Input: title, target_layer, facts (每个事实包含 text, 可选 targetId, op, qualification 等), evidence_ids
    #   - Output: KnowledgeProposal
    #   - Invariants: 每一个生成的 diff op 必须包含非空的 evidenceRefs，严格挂载到 evidence_ids 上；
    #   - Boundary conditions:
    #       - facts 为空时抛出 ValueError；
    #       - evidence_ids 为空时抛出 ValueError；
    #   - Test file: tests/test_knowledge_proposer.py
    """
    if not facts:
        raise ValueError("facts 列表不能为空")
    if not evidence_ids:
        raise ValueError("evidence_ids 列表不能为空，提案必须具备真实证据来源")

    operations: list[KnowledgeDiffOp] = []
    for f in facts:
        op_type: KnowledgeDiffOpType = f.get("op", "add")
        target_id_raw = f.get("targetId")
        target_id = UUID(str(target_id_raw)) if target_id_raw else None

        refs_raw = f.get("evidenceRefs")
        if refs_raw:
            refs = [UUID(str(r)) for r in refs_raw]
        else:
            refs = list(evidence_ids)

        payload_dict: dict[str, Any] = {"text": f.get("text", "")}
        if "reason" in f:
            payload_dict["reason"] = f["reason"]
        if "is_conflict" in f:
            payload_dict["is_conflict"] = f["is_conflict"]
        if "extra" in f and isinstance(f["extra"], dict):
            payload_dict.update(f["extra"])

        diff_op = build_diff_op(
            op=op_type,
            target_type=target_layer,
            evidence_refs=refs,
            target_id=target_id,
            payload=payload_dict,
            qualification=f.get("qualification"),
        )
        operations.append(diff_op)

    return create_proposal(
        title=title,
        target_layer=target_layer,
        operations=operations,
        evidence_ids=evidence_ids,
        proposer_model=proposer_model,
    )
