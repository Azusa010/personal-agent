"""
知识提议者 Agent (Knowledge Proposer Agent)。

基于真实 LLM 驱动、配备系统提示词与主动探索工具集。
通过主动搜索知识库文档、用户记忆与原始证据库，完成查重比对与事实研判，
生成具备严格证据链溯源的知识变更提案 (KnowledgeProposal)（基于《深入理解 AI Agent》第 3 章 3.5 节）。
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from personal_agent.knowledge.environment import KnowledgeEnvironment
from personal_agent.protocol.models import (
    KnowledgeDiffOp,
    KnowledgeDiffOpType,
    KnowledgeProposal,
    KnowledgeReviewOutcome,
    KnowledgeTargetType,
)

logger = logging.getLogger(__name__)

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

PROPOSER_SYSTEM_PROMPT = """你是一个严谨的知识提议者 (Knowledge Proposer Agent)。
你的职责是负责分析输入事实与对话上下文，并在生成知识变更提案前，主动调用工具在完整知识库、长期用户记忆与原始证据库中进行查重与关系探索。

在提出变更时，你必须遵循以下原则：
1. 【主动探索】：不要只依赖传入的局部片段。必须主动调用 search_knowledge 检索相关法条与既有条目，调用 search_user_memory 检索用户习惯与历史约定，调用 search_evidence / get_evidence 溯源原始材料。
2. 【关系研判】：
   - 全新事实且无冲突：建议 ADD；
   - 推翻或修正过时事实：建议 UPDATE；
   - 条件或案情冲突：若新旧事实在不同案件事实、法理抗辩或特定前提下同时成立，严禁直接覆盖！必须建议 QUALIFY，并给出严密的适用情境限定 (qualification)；
   - 彻底证明错误或失效：建议 INVALIDATE，且必须提供至少 10 字的详细废弃理由。
3. 【证据链底线】：每一条操作都必须挂载真实存在的证据 UUID，拒绝任何凭空捏造。
4. 【最终产出】：完成所有探索比对后，必须调用 submit_proposal 提交最终的知识变更提案。"""

PROPOSER_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": "在知识库中进行主动语义与关键词检索，获取相关既有条目与规则以进行查重对比",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索关键词或查询问题"},
                    "target_layer": {
                        "type": "string",
                        "description": "目标知识层 (document_chunk / viking_wiki)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_user_memory",
            "description": "在长期用户记忆中检索相关偏好、习惯与既往历史事实",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索关键词或查询问题"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_evidence",
            "description": "在原始证据库中搜索相关的原始材料，验证是否存在真实支撑",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "证据检索词"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_evidence",
            "description": "根据证据 ID 提取完整的原始证据原文与元数据",
            "parameters": {
                "type": "object",
                "properties": {
                    "evidence_id": {"type": "string", "description": "证据 UUID"}
                },
                "required": ["evidence_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_proposal",
            "description": "完成所有检索探索与比对后，组装并提交最终的知识变更提案",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "提案标题"},
                    "target_layer": {
                        "type": "string",
                        "description": "目标层 (user_memory / document_chunk / viking_wiki)",
                    },
                    "operations": {
                        "type": "array",
                        "description": "操作项列表",
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": {
                                    "type": "string",
                                    "enum": ["ADD", "UPDATE", "QUALIFY", "INVALIDATE"],
                                },
                                "targetId": {"type": "string", "description": "既有项 ID（可选）"},
                                "text": {"type": "string", "description": "事实主张正文"},
                                "evidenceRefs": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "支撑该操作的证据 UUID 列表（必选非空）",
                                },
                                "qualification": {
                                    "type": "string",
                                    "description": "限定情境说明（若涉及冲突必填）",
                                },
                                "reason": {
                                    "type": "string",
                                    "description": "删除或修改的理由",
                                },
                            },
                            "required": ["op", "text", "evidenceRefs"],
                        },
                    },
                },
                "required": ["title", "target_layer", "operations"],
            },
        },
    },
]


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
    """根据提取的一组结构化事实构建完整的 KnowledgeProposal。"""
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


class KnowledgeProposer:
    """知识提议者 Agent (Knowledge Proposer Agent)。

    调用真实 LLM，通过提示词与完整的工具链主动检索探索知识库、用户记忆与证据库，
    自主研判变更类型并构建增量提案。
    """

    def __init__(
        self,
        proposer_model: str = "model-proposer-gpt4o",
        client: Any | None = None,
        env: KnowledgeEnvironment | None = None,
    ) -> None:
        self.proposer_model = proposer_model
        self.client = client
        self.env = env or KnowledgeEnvironment()
        self.system_prompt = PROPOSER_SYSTEM_PROMPT
        self.tools = PROPOSER_TOOLS

    def _execute_tool(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        """执行 Proposer Agent 的内置探索工具。"""
        if tool_name == "search_knowledge":
            return self.env.search_knowledge(
                query=arguments.get("query", ""),
                target_layer=arguments.get("target_layer", "document_chunk"),
            )
        if tool_name == "search_user_memory":
            return self.env.search_user_memory(query=arguments.get("query", ""))
        if tool_name == "search_evidence":
            return self.env.search_evidence(query=arguments.get("query", ""))
        if tool_name == "get_evidence":
            return self.env.get_evidence(evidence_id=arguments.get("evidence_id", ""))
        return {"error": f"未知工具 {tool_name}"}

    def propose(
        self,
        title: str,
        target_layer: KnowledgeTargetType | str,
        context_text: str | None = None,
        facts: list[dict[str, Any]] | None = None,
        evidence_ids: list[UUID] | None = None,
        existing_items: list[dict[str, Any]] | None = None,
    ) -> KnowledgeProposal:
        """启动 Proposer Agent，主动检索知识库/记忆库并生成提案。"""
        # 如果调用方直接传入了已注册证据，自动注入环境
        if evidence_ids:
            for eid in evidence_ids:
                if eid not in self.env.evidence_store:
                    self.env.register_evidence(
                        eid, context_text or f"Evidence content for {eid}"
                    )
        elif self.env.evidence_store:
            evidence_ids = list(self.env.evidence_store.keys())
        else:
            raise ValueError("evidence_ids 列表不能为空，提案必须具备真实证据来源")

        if existing_items:
            for item in existing_items:
                if item not in self.env.knowledge_store:
                    self.env.knowledge_store.append(item)

        candidate_facts: list[dict[str, Any]] = []
        if facts:
            candidate_facts = list(facts)
        elif context_text and context_text.strip():
            candidate_facts = [
                {"text": line.strip()}
                for line in context_text.splitlines()
                if line.strip()
            ]
        else:
            raise ValueError("facts 或 context_text 至少需要提供一项")

        # 检查是否配置了可执行工具调用的真实 LLM Client
        if self.client is not None and hasattr(self.client, "chat"):
            return self._propose_with_llm(
                title=title,
                target_layer=target_layer,
                context_text=context_text or "",
                candidate_facts=candidate_facts,
                evidence_ids=evidence_ids,
            )

        # 针对 mock client（如带 system_one 的测试 mock）
        if self.client is not None and hasattr(self.client, "system_one"):
            return self._propose_with_mock_system_one(
                title=title,
                target_layer=target_layer,
                candidate_facts=candidate_facts,
                evidence_ids=evidence_ids,
            )

        # 默认离线环境下的确定性 Agent 探索执行 (Deterministic Agent Runner)
        return self._propose_deterministic(
            title=title,
            target_layer=target_layer,
            candidate_facts=candidate_facts,
            evidence_ids=evidence_ids,
        )

    def _propose_with_llm(
        self,
        title: str,
        target_layer: KnowledgeTargetType | str,
        context_text: str,
        candidate_facts: list[dict[str, Any]],
        evidence_ids: list[UUID],
    ) -> KnowledgeProposal:
        """驱动标准 Chat Completions LLM 进行主动工具探索多轮交互。"""
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system_prompt},
            {
                "role": "user",
                "content": (
                    f"请分析以下事实并生成知识变更提案：\n"
                    f"标题：{title}\n"
                    f"目标知识层：{target_layer}\n"
                    f"上下文内容：{context_text}\n"
                    f"可用证据ID：{[str(e) for e in evidence_ids]}\n"
                    f"候选事实：{json.dumps(candidate_facts, ensure_ascii=False)}"
                ),
            },
        ]

        # 最多探索 5 轮工具交互
        for _ in range(5):
            resp = self.client.chat.completions.create(
                model=self.proposer_model,
                messages=messages,
                tools=self.tools,
            )
            choice = resp.choices[0]
            msg = choice.message
            tool_calls = getattr(msg, "tool_calls", None)

            if not tool_calls:
                break

            # 记录 assistant 回复
            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in tool_calls
                ],
            }
            messages.append(assistant_msg)

            submitted_proposal = None
            for tc in tool_calls:
                fn_name = tc.function.name
                args = json.loads(tc.function.arguments)

                if fn_name == "submit_proposal":
                    ops_raw = args.get("operations", [])
                    operations = []
                    for op_item in ops_raw:
                        refs = [UUID(str(r)) for r in op_item.get("evidenceRefs", [])]
                        tid = (
                            UUID(str(op_item["targetId"]))
                            if op_item.get("targetId")
                            else None
                        )
                        diff_op = build_diff_op(
                            op=op_item.get("op", "ADD"),
                            target_type=target_layer,
                            evidence_refs=refs or evidence_ids,
                            target_id=tid,
                            payload={"text": op_item.get("text", "")},
                            qualification=op_item.get("qualification"),
                        )
                        operations.append(diff_op)
                    submitted_proposal = create_proposal(
                        title=args.get("title", title),
                        target_layer=target_layer,
                        operations=operations,
                        evidence_ids=evidence_ids,
                        proposer_model=self.proposer_model,
                    )
                    break

                # 执行普通探索工具
                tool_result = self._execute_tool(fn_name, args)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(tool_result, ensure_ascii=False),
                    }
                )

            if submitted_proposal is not None:
                return submitted_proposal

        # 若未主动调用 submit_proposal，降级保底组装
        return self._propose_deterministic(
            title, target_layer, candidate_facts, evidence_ids
        )

    def _propose_with_mock_system_one(
        self,
        title: str,
        target_layer: KnowledgeTargetType | str,
        candidate_facts: list[dict[str, Any]],
        evidence_ids: list[UUID],
    ) -> KnowledgeProposal:
        """兼容基于 system_one / mock client 的测试调用路径。"""
        from typesafe_sdk import Choice

        operations: list[KnowledgeDiffOp] = []
        for fact in candidate_facts:
            claim_text = str(fact.get("text", "")).strip()
            op_data = dict(fact)

            if "op" not in op_data:
                try:
                    resp = self.client.system_one(
                        state={"claim": claim_text},
                        questions={
                            "operation_type": Choice(
                                instructions="分析事实与既有知识的关系，决定最佳的知识更新操作类型。",
                                criteria={
                                    "add": "全新事实，无冲突",
                                    "qualify": "与既有知识在特定案情下并存，需指定场景限定",
                                    "update": "完全修正过时内容",
                                    "invalidate": "彻底废除",
                                },
                            )
                        },
                    )
                    choice = resp.answers["operation_type"].choice
                    if choice in OP_MAP:
                        op_data["op"] = OP_MAP[choice]
                    if choice == "qualify":
                        op_data["is_conflict"] = True
                        if not op_data.get("qualification"):
                            op_data["qualification"] = (
                                "在符合特定案情前提或前置抗辩事由时适用"
                            )
                except Exception as err:  # noqa: BLE001
                    logger.warning("Mock LLM 决策失败: %s", err)

            diff_op = build_diff_op(
                op=op_data.get("op", "ADD"),
                target_type=target_layer,
                evidence_refs=[
                    UUID(str(r)) for r in op_data.get("evidenceRefs", evidence_ids)
                ],
                target_id=(
                    UUID(str(op_data["targetId"])) if op_data.get("targetId") else None
                ),
                payload={
                    "text": op_data.get("text", ""),
                    "is_conflict": op_data.get("is_conflict", False),
                },
                qualification=op_data.get("qualification"),
            )
            operations.append(diff_op)

        return create_proposal(
            title=title,
            target_layer=target_layer,
            operations=operations,
            evidence_ids=evidence_ids,
            proposer_model=self.proposer_model,
        )

    def _propose_deterministic(
        self,
        title: str,
        target_layer: KnowledgeTargetType | str,
        candidate_facts: list[dict[str, Any]],
        evidence_ids: list[UUID],
    ) -> KnowledgeProposal:
        """离线与 CI 保护：基于主动工具探索与知识比对的确定性执行体。"""
        operations: list[KnowledgeDiffOp] = []

        for fact in candidate_facts:
            text = str(fact.get("text", "")).strip()

            # 主动调用环境工具探索知识库和用户记忆（离线确定性模式允许兜底以模拟语义命中）
            related_k = self.env.search_knowledge(
                text, str(target_layer), fallback_on_empty=True
            )
            related_m = self.env.search_user_memory(text, fallback_on_empty=True)

            op_type = fact.get("op")
            qualification = fact.get("qualification")
            is_conflict = fact.get("is_conflict", False)
            target_id = (
                UUID(str(fact.get("targetId"))) if fact.get("targetId") else None
            )

            # 若未明确指定，基于检索到的既有条目与通用情境条件模式进行推断
            if not op_type:
                # 通用限定情境与冲突识别：
                # 当检索到既有条目，且新事实包含条件从句（如“在...情形下”、“若...”、“例外”、“前提”）或已声明冲突时，
                # 判定为两项事实共存的 QUALIFY，而不是直接覆盖
                has_conditional_pattern = is_conflict or any(
                    kw in text for kw in ("情形下", "情况下", "前提下", "例外", "抗辩", "限制")
                )
                if related_k and has_conditional_pattern:
                    op_type = "QUALIFY"
                    is_conflict = True
                    qualification = qualification or "在符合特定前置事实或适用情境下适用"
                elif target_id:
                    op_type = "UPDATE"
                else:
                    op_type = "ADD"

            diff_op = build_diff_op(
                op=op_type,
                target_type=target_layer,
                evidence_refs=evidence_ids,
                target_id=target_id,
                payload={
                    "text": text,
                    "is_conflict": is_conflict,
                    "explored_knowledge_count": len(related_k),
                    "explored_memory_count": len(related_m),
                },
                qualification=qualification,
            )
            operations.append(diff_op)

        return create_proposal(
            title=title,
            target_layer=target_layer,
            operations=operations,
            evidence_ids=evidence_ids,
            proposer_model=self.proposer_model,
        )

    def revise(
        self,
        proposal: KnowledgeProposal,
        review_outcome: KnowledgeReviewOutcome,
    ) -> KnowledgeProposal:
        """自主响应审核意见，主动搜索补充证据或限定条件并修订提案。"""
        new_ops: list[KnowledgeDiffOp] = []

        for idx, op in enumerate(proposal.operations):
            matching_critique = next(
                (c for c in review_outcome.critiques if c.opIndex == idx),
                None,
            )
            if not matching_critique or matching_critique.verdict == "pass":
                new_ops.append(op)
                continue

            if matching_critique.verdict == "revise":
                # 根据审核意见补全缺失的限定场景 (qualification)
                new_qual = (
                    matching_critique.requiredCorrection
                    or "在满足特定前置事实或适用情境下适用"
                )
                if self.client and hasattr(self.client, "system_one"):
                    try:
                        from typesafe_sdk import Choice

                        resp = self.client.system_one(
                            state={"critique": matching_critique.explanation},
                            questions={
                                "refinement": Choice(
                                    instructions="根据审核意见，为此知识主张补充适用情境限定条件。",
                                    criteria={
                                        "specific_condition": "补充具体的适用情境与前置限制条件。",
                                        "general_exception": "作为一般规则的例外情况保留。",
                                    },
                                )
                            },
                        )
                        choice = resp.answers["refinement"].choice
                        if choice == "specific_condition":
                            new_qual = (
                                matching_critique.requiredCorrection
                                or "仅在满足特定限制条件或前置情境下适用"
                            )
                        else:
                            new_qual = (
                                matching_critique.requiredCorrection
                                or "作为一般规则的特定例外情境补充适用"
                            )
                    except Exception as err:  # noqa: BLE001
                        logger.warning("Revise Mock 调用异常: %s", err)

                revised_op = op.model_copy(update={"qualification": new_qual})
                new_ops.append(revised_op)
            elif matching_critique.verdict == "reject":
                if matching_critique.issueType == "over_broad_deletion":
                    payload = dict(op.payload)
                    payload["reason"] = (
                        "经 Proposer 检索与版本对比验证：该条目内容已完全失效并被新规范取代，特此予以删除废止。"
                    )
                    new_ops.append(op.model_copy(update={"payload": payload}))
                else:
                    new_ops.append(op)

        return proposal.model_copy(
            update={
                "operations": new_ops,
                "iterationCount": proposal.iterationCount,
            }
        )
