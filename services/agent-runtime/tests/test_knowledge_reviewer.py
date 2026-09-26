"""
Knowledge Reviewer 单元测试。

验证 Reviewer 作为具备提示词与只读工具链的 LLM Agent：
- 追溯原始证据库 (get_evidence / search_evidence)
- 对比多份文档与版本 (compare_versions / search_knowledge)
- 运行确定性规则检查 (run_rule_check)
- 【JEV专用工具化】：将 JEV 模型作为 evaluate_nli_entailment 工具调用，低 token 消耗核验语义蕴含
- 处理 LLM 多轮工具审查流程
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

from personal_agent.knowledge.environment import KnowledgeEnvironment
from personal_agent.knowledge.proposer import build_diff_op, create_proposal
from personal_agent.knowledge.reviewer import (
    REVIEWER_SYSTEM_PROMPT,
    KnowledgeReviewer,
)


def test_reviewer_has_system_prompt_and_tools():
    reviewer = KnowledgeReviewer()
    assert "知识审核者" in reviewer.system_prompt
    assert REVIEWER_SYSTEM_PROMPT == reviewer.system_prompt
    tool_names = [t["function"]["name"] for t in reviewer.tools]
    assert "get_evidence" in tool_names
    assert "search_evidence" in tool_names
    assert "search_knowledge" in tool_names
    assert "compare_versions" in tool_names
    assert "run_rule_check" in tool_names
    assert "evaluate_nli_entailment" in tool_names
    assert "submit_review" in tool_names


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
    ev_fake = uuid4()

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


def test_reviewer_jev_nli_tool_supported():
    mock_jev = MagicMock()
    mock_resp = MagicMock()
    mock_resp.answers = {"nli_support": MagicMock(choice="supported")}
    mock_jev.system_one.return_value = mock_resp

    env = KnowledgeEnvironment()
    ev = uuid4()
    env.register_evidence(
        ev, "刑法第二百六十四条：盗窃公私财物数额较大处三年以下有期徒刑"
    )

    reviewer = KnowledgeReviewer(jev_client=mock_jev, env=env)

    op = build_diff_op(
        "add",
        "chunk",
        [ev],
        payload={"text": "盗窃公私财物数额较大处三年以下有期徒刑"},
    )
    proposal = create_proposal("法条提案", "chunk", [op], [ev])

    # 审核者追溯原始证据，并调用 evaluate_nli_entailment (JEV tool) 验证
    outcome = reviewer.review(proposal, {ev})
    assert outcome.verdict == "approved"
    assert outcome.critiques[0].verdict == "pass"
    assert mock_jev.system_one.called


def test_reviewer_jev_nli_tool_hallucinated_rejects():
    mock_jev = MagicMock()
    mock_resp = MagicMock()
    mock_resp.answers = {"nli_support": MagicMock(choice="hallucinated")}
    mock_jev.system_one.return_value = mock_resp

    env = KnowledgeEnvironment()
    ev = uuid4()
    env.register_evidence(
        ev, "刑法第二百六十四条：盗窃公私财物数额较大处三年以下有期徒刑"
    )

    reviewer = KnowledgeReviewer(jev_client=mock_jev, env=env)

    # 提案断言严重脱离法条证据（捏造死刑）
    op = build_diff_op(
        "add",
        "chunk",
        [ev],
        payload={"text": "盗窃罪一律判处死刑并没收全部个人财产"},
    )
    proposal = create_proposal("伪造严重量刑提案", "chunk", [op], [ev])

    # JEV 工具判定为 hallucinated，Reviewer 拦截拒绝
    outcome = reviewer.review(proposal, {ev})
    assert outcome.verdict == "rejected"
    assert outcome.critiques[0].verdict == "reject"
    assert outcome.critiques[0].issueType == "lacks_evidence"
    assert "未能有效支撑" in outcome.critiques[0].explanation


def test_reviewer_compare_versions_tool():
    reviewer = KnowledgeReviewer()
    old_text = "故意伤害致人重伤的，处三年以上十年以下有期徒刑。"
    new_text = "故意伤害致人重伤的，处三年以上十年以下有期徒刑；具有防卫过当情节的，减轻或者免除处罚。"

    res = reviewer.execute_tool(
        "compare_versions", {"old_text": old_text, "new_text": new_text}
    )
    assert "similarity_ratio" in res
    assert res["similarity_ratio"] > 0.6
    assert len(res["diff_lines"]) > 0


def test_reviewer_llm_chat_completions_flow():
    mock_client = MagicMock()
    ev = uuid4()

    # 第一轮：LLM 主动调用 get_evidence 和 evaluate_nli_entailment
    call_get_ev = SimpleNamespace(
        id="call-1",
        function=SimpleNamespace(
            name="get_evidence",
            arguments=json.dumps({"evidence_id": str(ev)}),
        ),
    )
    resp1 = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    role="assistant", tool_calls=[call_get_ev]
                )
            )
        ]
    )

    # 第二轮：LLM 根据证据调用 submit_review 做出通过结论
    call_submit = SimpleNamespace(
        id="call-2",
        function=SimpleNamespace(
            name="submit_review",
            arguments=json.dumps(
                {
                    "verdict": "approved",
                    "comments": "证据查验真实且结论充分支撑",
                    "critiques": [
                        {
                            "opIndex": 0,
                            "verdict": "pass",
                            "explanation": "真实法条依据有效",
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

    env = KnowledgeEnvironment()
    env.register_evidence(ev, "真实法条")
    reviewer = KnowledgeReviewer(client=mock_client, env=env)

    op = build_diff_op("add", "chunk", [ev], payload={"text": "真实法条事实"})
    proposal = create_proposal("合规审查提案", "chunk", [op], [ev])

    outcome = reviewer.review(proposal)
    assert outcome.verdict == "approved"
    assert outcome.critiques[0].verdict == "pass"
    assert mock_client.chat.completions.create.call_count == 2
