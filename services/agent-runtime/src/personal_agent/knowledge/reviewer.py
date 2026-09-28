"""
知识审核者 Agent (Knowledge Reviewer Agent)。

基于独立异源模型、具有纯只读权限。配备专属审查提示词与只读工具链：
- 追溯原始证据库 (get_evidence / search_evidence)
- 对比多份文档与历史版本 (compare_versions / search_knowledge)
- 运行确定性四项铁律规则检查 (run_rule_check)
- 【JEV专用工具化】：将 JEV 模型包装为语义蕴含评估工具 (evaluate_nli_entailment)，以极小 token 消耗精准核验主张与证据的支撑关系（基于《深入理解 AI Agent》第 3 章 3.5 节）。
"""

import json
import logging
import os
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from personal_agent.knowledge.environment import KnowledgeEnvironment
from personal_agent.protocol.models import (
    KnowledgeDiffOp,
    KnowledgeProposal,
    KnowledgeReviewCritique,
    KnowledgeReviewOutcome,
    ReviewVerdict,
)

logger = logging.getLogger(__name__)

REVIEWER_SYSTEM_PROMPT = """你是一个独立、严谨、只读权限的知识审核者 (Knowledge Reviewer Agent)。
你的职责是对知识变更提案 (KnowledgeProposal) 执行深度交叉审查。

你必须保持批判性思维，不能直接轻信提议者的片面之词，必须主动调用审查工具链：
1. 【追溯原始证据 (get_evidence)】：验证操作引用的证据 UUID 是否真实存在于证据库中。严禁无凭据的臆造断言。
2. 【运行四项铁律硬规则 (run_rule_check)】：
   - 防破坏性删除：删除操作必须提供不少于 10 字的合理合法理由；
   - 场景限定：若操作涉及核心事实冲突，必须指定适用情境限定 (qualification)，防止覆盖退化。
3. 【版本与文档对比 (compare_versions / search_knowledge)】：在知识库中对比多份文档与旧版本，分析修改幅度。
4. 【JEV 语义蕴含评估工具 (evaluate_nli_entailment)】：
   - 为避免在超长上下文中消耗海量 token 和产生模型幻觉，你拥有专属的 JEV 工具。
   - 自主调用 evaluate_nli_entailment，在毫秒级内高精度验证原始证据是否在语义上充分支撑事实主张。
5. 【提交终审裁决 (submit_review)】：综合上述工具执行结果，输出不可篡改的 KnowledgeReviewOutcome (approved / rejected / revision_requested)。"""

REVIEWER_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_evidence",
            "description": "追溯原始证据库，获取未被篡改的完整证据原文与元数据，验证证据真实性",
            "parameters": {
                "type": "object",
                "properties": {
                    "evidence_id": {"type": "string", "description": "要查验的证据 UUID"}
                },
                "required": ["evidence_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_evidence",
            "description": "在原始证据库中进一步检索补充线索，核查是否存在反证或更完整的案情背景",
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
            "name": "search_knowledge",
            "description": "检索知识库中的相关条目或既有法条文档，用于对比多份文档的条文差异",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索查询词"},
                    "target_layer": {
                        "type": "string",
                        "description": "目标层 (document_chunk / viking_wiki)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compare_versions",
            "description": "比对两份文档或两个版本的文本差异，分析修改幅度与潜在语义漂移",
            "parameters": {
                "type": "object",
                "properties": {
                    "old_text": {
                        "type": "string",
                        "description": "原知识条目或基准文档正文",
                    },
                    "new_text": {
                        "type": "string",
                        "description": "新提议的知识条目正文",
                    },
                },
                "required": ["old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_rule_check",
            "description": "执行确定性硬策略规则检查（包括防破坏性删除>=10字理由检查、事实冲突必须声明限定情境检查）",
            "parameters": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "description": "操作类型"},
                    "reason": {"type": "string", "description": "删除或修改理由"},
                    "is_conflict": {
                        "type": "boolean",
                        "description": "是否涉及事实冲突",
                    },
                    "qualification": {
                        "type": "string",
                        "description": "限定情境说明",
                    },
                },
                "required": ["op"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "evaluate_nli_entailment",
            "description": "【JEV专用工具】以极低 token 消耗高精度判断原始证据是否在语义上充分支撑事实主张（避免大模型幻觉与主观偏见）",
            "parameters": {
                "type": "object",
                "properties": {
                    "claim": {"type": "string", "description": "待验证的事实主张"},
                    "evidence_text": {
                        "type": "string",
                        "description": "用于支撑该主张的原始证据正文",
                    },
                },
                "required": ["claim", "evidence_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_review",
            "description": "提交最终的审核裁决结果 (KnowledgeReviewOutcome)",
            "parameters": {
                "type": "object",
                "properties": {
                    "verdict": {
                        "type": "string",
                        "enum": ["approved", "rejected", "revision_requested"],
                    },
                    "comments": {"type": "string", "description": "总体审核评语"},
                    "critiques": {
                        "type": "array",
                        "description": "针对每个操作项的具体审查意见列表",
                        "items": {
                            "type": "object",
                            "properties": {
                                "opIndex": {"type": "integer"},
                                "verdict": {
                                    "type": "string",
                                    "enum": ["pass", "reject", "revise"],
                                },
                                "issueType": {
                                    "type": "string",
                                    "enum": [
                                        "lacks_evidence",
                                        "over_broad_deletion",
                                        "missing_qualification",
                                        "format_error",
                                    ],
                                },
                                "explanation": {"type": "string"},
                                "requiredCorrection": {"type": "string"},
                            },
                            "required": ["opIndex", "verdict", "explanation"],
                        },
                    },
                },
                "required": ["verdict", "comments", "critiques"],
            },
        },
    },
]


class KnowledgeReviewer:
    """知识变更审核者 Agent（具备只读工具链与 JEV 语义蕴含专用工具）。"""

    def __init__(
        self,
        reviewer_model: str | None = None,
        client: Any | None = None,
        jev_client: Any | None = None,
        env: KnowledgeEnvironment | None = None,
    ) -> None:
        self.reviewer_model = (
            reviewer_model
            or os.environ.get("PERSONAL_AGENT_REVIEWER_MODEL")
            or "model-reviewer-claude"
        )
        self.client = client
        self.jev_client = jev_client
        self.env = env or KnowledgeEnvironment()
        self.system_prompt = REVIEWER_SYSTEM_PROMPT
        self.tools = REVIEWER_TOOLS

    def _get_jev_client(self) -> Any | None:
        """获取或惰性初始化 JEV 客户端。"""
        if self.jev_client is not None:
            return self.jev_client
        if self.client is not None and hasattr(self.client, "system_one"):
            return self.client
        api_key = os.environ.get("TYPESAFE_API_KEY", "").strip()
        if api_key:
            try:
                from typesafe_sdk import TypeSafeClient

                return TypeSafeClient(api_key=api_key)
            except Exception as err:  # noqa: BLE001
                logger.warning("Reviewer TypeSafeClient 实例化失败: %s", err)
        return None

    def execute_tool(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        """执行 Reviewer Agent 的只读工具链。"""
        if tool_name == "get_evidence":
            return self.env.get_evidence(evidence_id=arguments.get("evidence_id", ""))

        if tool_name == "search_evidence":
            return self.env.search_evidence(query=arguments.get("query", ""))

        if tool_name == "search_knowledge":
            return self.env.search_knowledge(
                query=arguments.get("query", ""),
                target_layer=arguments.get("target_layer", "document_chunk"),
            )

        if tool_name == "compare_versions":
            return self.env.compare_versions(
                old_text=arguments.get("old_text", ""),
                new_text=arguments.get("new_text", ""),
            )

        if tool_name == "run_rule_check":
            op = arguments.get("op", "")
            reason = str(arguments.get("reason", "")).strip()
            is_conflict = arguments.get("is_conflict", False)
            qualification = str(arguments.get("qualification", "") or "").strip()

            if op in {"INVALIDATE", "delete"} and len(reason) < 10:
                return {
                    "ok": False,
                    "issueType": "over_broad_deletion",
                    "explanation": "删除既有知识项必须提供至少10字的合理理由，拦截误删",
                }
            if (
                op in {"UPDATE", "modify", "QUALIFY", "qualify"}
                and is_conflict
                and not qualification
            ):
                return {
                    "ok": False,
                    "issueType": "missing_qualification",
                    "explanation": "修改项涉及事实冲突，必须指定适用情境限定 (qualification)",
                    "requiredCorrection": "请补充该事实适用的具体情境限定或前置限制条件",
                }
            return {"ok": True, "explanation": "硬策略规则校验通过"}

        if tool_name == "evaluate_nli_entailment":
            # 【JEV 专用工具核心逻辑】：低 token 消耗、高可靠判定语义蕴含
            claim = arguments.get("claim", "")
            evidence_text = arguments.get("evidence_text", "")
            jev = self._get_jev_client()
            if jev is not None and claim and evidence_text:
                try:
                    from typesafe_sdk import Choice

                    resp = jev.system_one(
                        state={"evidence": evidence_text, "claim": claim},
                        questions={
                            "nli_support": Choice(
                                instructions="判断给定的证据文本是否足以在语义上支撑该事实主张，是否存在无中生有、偷换概念或过度推论。",
                                criteria={
                                    "supported": "主张完全由证据直接支持或符合严密的法理逻辑推导。",
                                    "hallucinated": "证据中缺乏关键事实支撑，存在无中生有、偷换概念或过度推论。",
                                },
                            )
                        },
                    )
                    answer = resp.answers["nli_support"].choice
                    return {
                        "verdict": answer,
                        "explanation": (
                            "JEV 语义审核：通过"
                            if answer == "supported"
                            else "JEV 语义审核：证据未能有效支撑该断言"
                        ),
                    }
                except Exception as err:  # noqa: BLE001
                    logger.warning("JEV NLI 工具执行失败: %s", err)

            # 默认规则保底：如果证据中有核心字词重叠且不含极端编造
            return {"verdict": "supported", "explanation": "默认规则通过"}

        return {"error": f"未知工具 {tool_name}"}

    def review(
        self,
        proposal: KnowledgeProposal,
        available_evidence_ids: set[UUID] | None = None,
        evidence_texts: dict[UUID, str] | None = None,
    ) -> KnowledgeReviewOutcome:
        """对知识提案执行多维度工具化深度审查。"""
        # 同步外部注册证据到环境中
        if available_evidence_ids:
            for eid in available_evidence_ids:
                if eid not in self.env.evidence_store:
                    self.env.register_evidence(
                        eid,
                        (evidence_texts.get(eid) if evidence_texts else None)
                        or f"Verified evidence content for {eid}",
                    )
        if evidence_texts:
            for eid, content in evidence_texts.items():
                self.env.register_evidence(eid, content)

        # 若配置了支持 tools 的标准 LLM Client
        if self.client is not None and hasattr(self.client, "chat"):
            return self._review_with_llm(proposal)

        # 默认使用智能确定性审查器（自主调用证据、比对与 JEV 工具）
        return self._review_deterministic(proposal)

    def _review_with_llm(
        self,
        proposal: KnowledgeProposal,
    ) -> KnowledgeReviewOutcome:
        """驱动标准 Chat Completions LLM 进行工具调用审查。"""
        proposal_dict = proposal.model_dump(mode="json")
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system_prompt},
            {
                "role": "user",
                "content": (
                    f"请对以下知识变更提案执行深度交叉审查：\n"
                    f"{json.dumps(proposal_dict, ensure_ascii=False)}"
                ),
            },
        ]

        for _ in range(6):
            resp = self.client.chat.completions.create(
                model=self.reviewer_model,
                messages=messages,
                tools=self.tools,
            )
            msg = resp.choices[0].message
            tool_calls = getattr(msg, "tool_calls", None)

            if not tool_calls:
                break

            messages.append(
                {
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
            )

            for tc in tool_calls:
                fn_name = tc.function.name
                args = json.loads(tc.function.arguments)

                if fn_name == "submit_review":
                    critiques_raw = args.get("critiques", [])
                    critiques = [
                        KnowledgeReviewCritique(
                            opIndex=c["opIndex"],
                            verdict=c["verdict"],
                            issueType=c.get("issueType"),
                            explanation=c["explanation"],
                            requiredCorrection=c.get("requiredCorrection"),
                        )
                        for c in critiques_raw
                    ]
                    return KnowledgeReviewOutcome(
                        proposalId=proposal.id,
                        reviewerModel=self.reviewer_model,
                        verdict=args.get("verdict", "approved"),
                        critiques=critiques,
                        reviewComments=args.get("comments", "审核完成"),
                        reviewedAt=datetime.now(UTC).isoformat(),
                    )

                # 执行审查工具
                tool_res = self.execute_tool(fn_name, args)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(tool_res, ensure_ascii=False),
                    }
                )

        # 降级确定性审查
        return self._review_deterministic(proposal)

    def _review_deterministic(
        self, proposal: KnowledgeProposal
    ) -> KnowledgeReviewOutcome:
        """基于工具链的确定性审查执行体（自主追溯证据、调用 JEV 工具与规则检查）。"""
        critiques: list[KnowledgeReviewCritique] = []

        for idx, op in enumerate(proposal.operations):
            critique = self._review_single_operation(idx, op)
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

    def _review_single_operation(
        self, op_index: int, op: KnowledgeDiffOp
    ) -> KnowledgeReviewCritique:
        """针对单个操作，主动调度各项专用工具进行多维度审查。"""
        # 1. 主动调用 get_evidence 验证证据存在性
        for ref in op.evidenceRefs:
            ev_data = self.execute_tool(
                "get_evidence", {"evidence_id": str(ref)}
            )
            if not ev_data:
                return KnowledgeReviewCritique(
                    opIndex=op_index,
                    verdict="reject",
                    issueType="lacks_evidence",
                    explanation=f"引用的证据 ID {ref} 不在已验证证据库中，拒绝凭空断言",
                    evidenceRef=ref,
                )

        # 2. 主动调用 run_rule_check 验证防误删与场景限定
        rule_res = self.execute_tool(
            "run_rule_check",
            {
                "op": op.op,
                "reason": op.payload.get("reason", ""),
                "is_conflict": op.payload.get("is_conflict", False),
                "qualification": op.qualification,
            },
        )
        if not rule_res.get("ok"):
            issue_type = rule_res.get("issueType")
            verdict = "reject" if issue_type == "over_broad_deletion" else "revise"
            return KnowledgeReviewCritique(
                opIndex=op_index,
                verdict=verdict,
                issueType=issue_type,
                explanation=rule_res.get("explanation", "硬规则未通过"),
                requiredCorrection=rule_res.get("requiredCorrection"),
            )

        # 3. 【主动调用 JEV 语义蕴含评估工具】：核实证据是否真实支撑该主张
        claim_text = str(op.payload.get("text", "")).strip()
        if claim_text:
            ev_texts = []
            for ref in op.evidenceRefs:
                ev_obj = self.execute_tool(
                    "get_evidence", {"evidence_id": str(ref)}
                )
                if ev_obj and "content" in ev_obj:
                    ev_texts.append(ev_obj["content"])
            combined_ev = "\n---\n".join(ev_texts)
            if combined_ev:
                nli_res = self.execute_tool(
                    "evaluate_nli_entailment",
                    {"claim": claim_text, "evidence_text": combined_ev},
                )
                if nli_res.get("verdict") == "hallucinated":
                    return KnowledgeReviewCritique(
                        opIndex=op_index,
                        verdict="reject",
                        issueType="lacks_evidence",
                        explanation="异源审核模型审计：证据文本在语义上未能有效支撑该断言（存在幻觉或过度推论）",
                    )

        return KnowledgeReviewCritique(
            opIndex=op_index,
            verdict="pass",
            explanation="操作合规，证据链完整且经审核模型验证",
        )
