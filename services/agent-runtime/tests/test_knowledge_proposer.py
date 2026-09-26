"""
Knowledge Proposer 单元测试。

验证 Proposer 作为具备提示词与工具链的 LLM Agent：
- 主动查询完整知识库与用户记忆环境
- 自主决策 ADD / UPDATE / QUALIFY
- 处理 LLM 多轮工具调用交互 (Chat Completions)
- 自主修订 (revise)
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from personal_agent.knowledge.environment import KnowledgeEnvironment
from personal_agent.knowledge.proposer import (
    PROPOSER_SYSTEM_PROMPT,
    KnowledgeProposer,
    build_diff_op,
    build_proposal_from_facts,
    create_proposal,
)
from personal_agent.knowledge.reviewer import KnowledgeReviewer
from personal_agent.knowledge.update_loop import KnowledgeUpdateLoop


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
        target_layer="document_chunk",
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
        build_proposal_from_facts("空事实", "document_chunk", [], [ev])

    with pytest.raises(ValueError, match="evidence_ids 列表不能为空"):
        build_proposal_from_facts(
            "无证据", "document_chunk", [{"text": "事实"}], []
        )


def test_knowledge_proposer_has_system_prompt_and_tools():
    proposer = KnowledgeProposer()
    assert "知识提议者" in proposer.system_prompt
    assert PROPOSER_SYSTEM_PROMPT == proposer.system_prompt
    tool_names = [t["function"]["name"] for t in proposer.tools]
    assert "search_knowledge" in tool_names
    assert "search_user_memory" in tool_names
    assert "search_evidence" in tool_names
    assert "get_evidence" in tool_names
    assert "submit_proposal" in tool_names


def test_knowledge_proposer_actively_explores_environment():
    # 模拟环境：既有知识中包含故意伤害罪，用户偏好中包含指导案例
    env = KnowledgeEnvironment(
        knowledge_store=[
            {"id": "doc-1", "text": "刑法规定故意伤害致人伤害的构成故意伤害罪"}
        ],
        memory_store=[
            {"subject": "检索偏好", "content": "优先适用正当防卫最新指导案例"}
        ],
    )
    ev_id = uuid4()
    env.register_evidence(
        ev_id, "正当防卫免责事由证据：在面临不法侵害时防卫不负刑事责任"
    )

    proposer = KnowledgeProposer(env=env)

    # 提议者分析正当防卫事实，主动探索环境后识别与故意伤害罪的关系为 QUALIFY
    proposal = proposer.propose(
        title="正当防卫规则提案",
        target_layer="document_chunk",
        context_text="在正当防卫情形下造成轻伤的，依法不负刑事责任。",
        evidence_ids=[ev_id],
    )

    assert len(proposal.operations) == 1
    op = proposal.operations[0]
    assert op.op == "QUALIFY"
    assert op.qualification is not None
    assert len(op.qualification.strip()) > 0
    # 验证主动探索了环境数据
    assert op.payload.get("explored_knowledge_count", 0) >= 1


def test_knowledge_proposer_llm_chat_completions_flow():
    # 模拟真实 LLM 通过 Chat Completions Function Calling 发起多轮工具交互
    mock_client = MagicMock()
    ev_id = uuid4()

    # 第一轮：LLM 主动调用 search_knowledge 和 search_user_memory
    call_search = SimpleNamespace(
        id="call-search",
        function=SimpleNamespace(
            name="search_knowledge",
            arguments=json.dumps({"query": "过失致人重伤"}),
        ),
    )
    resp1 = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    role="assistant", tool_calls=[call_search]
                )
            )
        ]
    )

    # 第二轮：LLM 掌握信息后调用 submit_proposal
    call_submit = SimpleNamespace(
        id="call-submit",
        function=SimpleNamespace(
            name="submit_proposal",
            arguments=json.dumps(
                {
                    "title": "过失罪责提案",
                    "target_layer": "document_chunk",
                    "operations": [
                        {
                            "op": "ADD",
                            "text": "过失致人重伤处三年以下有期徒刑",
                            "evidenceRefs": [str(ev_id)],
                        }
                    ],
                }
            ),
        ),
    )
    resp2 = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    role="assistant", tool_calls=[call_submit]
                )
            )
        ]
    )

    mock_client.chat.completions.create.side_effect = [resp1, resp2]

    proposer = KnowledgeProposer(
        proposer_model="mock-gpt4o", client=mock_client
    )
    proposal = proposer.propose(
        title="过失罪责提案",
        target_layer="document_chunk",
        context_text="过失致人重伤法条",
        evidence_ids=[ev_id],
    )

    assert proposal.title == "过失罪责提案"
    assert len(proposal.operations) == 1
    assert proposal.operations[0].op == "ADD"
    assert proposal.operations[0].evidenceRefs == [ev_id]
    assert mock_client.chat.completions.create.call_count == 2


def test_knowledge_proposer_revise_missing_qualification():
    mock_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.answers = {"refinement": MagicMock(choice="specific_condition")}
    mock_client.system_one.return_value = mock_resp

    proposer = KnowledgeProposer(client=mock_client)
    reviewer = KnowledgeReviewer()
    ev = uuid4()

    op = build_diff_op(
        op="UPDATE",
        target_type="document_chunk",
        evidence_refs=[ev],
        payload={"text": "特殊减免量刑", "is_conflict": True},
        qualification=None,
    )
    initial_proposal = create_proposal("未限定提案", "chunk", [op], [ev])

    outcome = reviewer.review(initial_proposal, {ev})
    assert outcome.verdict == "revision_requested"

    revised_proposal = proposer.revise(initial_proposal, outcome)
    assert revised_proposal.operations[0].qualification is not None
    assert (
        "情境" in revised_proposal.operations[0].qualification
        or "限制条件" in revised_proposal.operations[0].qualification
    )


def test_knowledge_proposer_and_reviewer_closed_loop():
    proposer = KnowledgeProposer()
    reviewer = KnowledgeReviewer()
    loop = KnowledgeUpdateLoop(reviewer=reviewer, max_iterations=3)

    ev = uuid4()
    op = build_diff_op(
        op="UPDATE",
        target_type="document_chunk",
        evidence_refs=[ev],
        payload={"text": "自首情节减轻处罚", "is_conflict": True},
        qualification=None,
    )
    proposal = create_proposal("量刑变更提案", "chunk", [op], [ev])

    final_proposal, outcomes = loop.run_review_cycle(
        initial_proposal=proposal,
        available_evidence_ids={ev},
        revision_handler=proposer.revise,
    )

    assert final_proposal.status == "approved"
    assert final_proposal.iterationCount == 2
    assert len(outcomes) == 2
    assert outcomes[0].verdict == "revision_requested"
    assert outcomes[1].verdict == "approved"
    assert final_proposal.operations[0].qualification is not None
