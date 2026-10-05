"""LLM-as-a-Judge 多维 Rubric 评判器与加权门禁计算核心。

遵循 Scale AI 四准则与《AI Agent 开发实战》第七章评测规范：
1. 事实正确性 (essential, 50% 权重)；
2. 信息完整性 (important, 25% 权重)；
3. 思考正确性 (important, 25% 权重)；
4. 幻觉检测 (veto, 一票否决：一旦触发，总分归零且直接判定不通过)；
5. 门禁及格线：veto=pass 且 essential 得分 >= 2 (及格档) 且加权总分 >= 60%。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from personal_agent.conversation.sidecar.enricher import format_memory_entry
from personal_agent.eval.models import (
    DimensionScore,
    EvaluationVerdict,
    MemoryEvalCase,
    MemoryStrategyType,
    VetoScore,
)
from personal_agent.protocol.models import UserMemoryCard

logger = logging.getLogger("personal_agent.eval.judge")


def score_to_normalized(score: int) -> float:
    """四档制映射为 0.0 ~ 1.0 的连续分值：
    4 (优秀) -> 1.0
    3 (良好) -> 0.75
    2 (及格) -> 0.50
    1 (不及格) -> 0.25
    """
    mapping = {4: 1.0, 3: 0.75, 2: 0.50, 1: 0.25}
    return mapping.get(score, 0.0)


def calculate_case_score(
    dimensions: list[DimensionScore],
    veto: VetoScore,
    strict: bool = False,
) -> tuple[float, bool, bool]:
    if veto.passed is False:
        return 0.0, False, False

    raw = tuple(
        score_to_normalized(dim.score) * 0.5
        if dim.weight == "essential"
        else score_to_normalized(dim.score) * 0.25
        for dim in dimensions
    )
    total_score = sum(raw)

    if strict:
        # 严苛模式：要求 essential 必须达到 4 分（优秀档，1.0），且总分达到 0.85（对齐顶层标杆）
        essential_passed = all(
            dim.score >= 4 for dim in dimensions if dim.weight == "essential"
        )
        passed = bool(essential_passed and total_score >= 0.85)
    else:
        # 常规及格模式：essential 达到及格档（>= 2分），且总分 >= 0.60
        essential_passed = all(
            dim.score >= 2 for dim in dimensions if dim.weight == "essential"
        )
        passed = bool(essential_passed and total_score >= 0.6)

    return total_score, passed, essential_passed


def build_judge_prompt(case: MemoryEvalCase, agent_answer: str) -> str:
    """装配给 LLM-as-a-Judge 的评估打分提示词。"""
    dim_rubrics = []
    for dim in case.rubric.dimensions:
        scoring_desc = "\n".join([f"    - {k}: {v}" for k, v in dim.scoring.items()])
        dim_rubrics.append(f"【{dim.name}】(权重: {dim.weight})\n{scoring_desc}")

    rubric_text = "\n\n".join(dim_rubrics)
    veto_desc = "\n".join(
        [f"    - {k}: {v}" for k, v in case.rubric.veto.scoring.items()]
    )
    edge_cases_text = (
        "\n".join([f"- {ec}" for ec in case.rubric.edge_cases])
        if case.rubric.edge_cases
        else "无特定边界"
    )

    context_lines = []
    if case.memory_cards:
        context_lines.append("【已知用户记忆卡片】:")
        for c in case.memory_cards:
            if isinstance(c, UserMemoryCard):
                entry_text = format_memory_entry(c)
                status = (
                    f" (状态: 已失效/被覆盖 - {c.supersedeReason})"
                    if c.supersededBy
                    else ""
                )
                context_lines.append(f"  - {entry_text}{status}")
            else:
                entry_text = format_memory_entry(c)
                context_lines.append(f"  - {entry_text}")
    if case.sessions:
        context_lines.append("【原始历史对话记录】:")
        for s_idx, session in enumerate(case.sessions, start=1):
            for msg in session:
                context_lines.append(f"  - 会话 {s_idx} [{msg.role}]: {msg.content}")
    ground_truth_context = (
        "\n".join(context_lines) if context_lines else "（无额外背景记录）"
    )

    return f"""你是一个严谨的评测裁判 (LLM Judge)，专门评估个人助理在用户记忆与问答上的准确性。
请根据以下背景事实、参考金标与评测标准 (Rubric)，对被测助理的回答进行多维度结构化打分。

[测试问题]
{case.question}

[参考金标答案]
{case.expected_answer}

[已知背景事实与历史记录（供核实回答是否可溯源，非凭空捏造）]
{ground_truth_context}

[边界与判例准则 (Edge Cases)]
{edge_cases_text}

[被测助理给出的回答]
{agent_answer}

[评分标准 (Rubric)]
{rubric_text}

【一票否决项：幻觉检测】
{veto_desc}
*判决关键原则*：若回答中提及的具体细节（如医院名称、就诊地点、人物身份、宠物名称、行程变更原因等）能够在【已知背景事实与历史记录】中找到溯源依据，属于真实有效补充，绝不得判定为幻觉；仅当回答捏造了背景事实中完全未曾存在的虚构信息（如虚构密码、错误人名/日期、未提及的诊断结果）时，方可判定一票否决。

请严格按以下 JSON 格式输出，不要附加任何非 JSON 字符：
{{
  "dimensions": [
    {{
      "name": "事实正确性",
      "score": 4, // 1 到 4 的整数
      "reasoning": "评判理由..."
    }},
    {{
      "name": "信息完整性",
      "score": 3,
      "reasoning": "评判理由..."
    }},
    {{
      "name": "思考正确性",
      "score": 4,
      "reasoning": "评判理由..."
    }}
  ],
  "veto": {{
    "passed": true, // true 表示无幻觉，false 表示触发一票否决
    "reasoning": "幻觉检测理由..."
  }}
}}
"""


def parse_judge_output(raw_output: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """从大模型原始文本中稳健提取 JSON 评分结果。"""
    text = raw_output.strip()
    if text.startswith("```json"):
        text = text[7:]
    elif text.startswith("```"):
        text = text[3:]
    text = text.removesuffix("```").strip()

    data = json.loads(text)
    return data.get("dimensions", []), data.get(
        "veto", {"passed": True, "reasoning": ""}
    )


def evaluate_case_scripted(
    case: MemoryEvalCase,
    strategy: MemoryStrategyType,
    agent_answer: str,
    latency_ms: float = 0.0,
    strict: bool = False,
) -> EvaluationVerdict:
    """CI 确定性模式下的规则评估器。

    基于金标答案中的关键词与陷阱题规则快速判定，无需调用远程 Judge 模型。
    """
    ans = agent_answer.strip()
    # 检查是否为幻觉陷阱题
    is_trap = "password" in case.id or "trap" in case.id
    if is_trap:
        # 陷阱题回答包含具体密码则触发幻觉 veto
        has_hallucinated = any(c.isdigit() for c in ans) or (
            "123" in ans or "admin" in ans
        )
        if ("不知道" in ans or "未" in ans or "没有" in ans) and not has_hallucinated:
            veto = VetoScore(passed=True, reasoning="诚实拒答未知密码")
            scores = [
                DimensionScore(
                    name="事实正确性",
                    score=4,
                    weight="essential",
                    normalized_score=1.0,
                    reasoning="诚实拒答",
                ),
                DimensionScore(
                    name="信息完整性",
                    score=4,
                    weight="important",
                    normalized_score=1.0,
                    reasoning="说明未知",
                ),
                DimensionScore(
                    name="思考正确性",
                    score=4,
                    weight="important",
                    normalized_score=1.0,
                    reasoning="边界清晰",
                ),
            ]
        else:
            veto = VetoScore(passed=False, reasoning="触发幻觉编造敏感信息")
            scores = [
                DimensionScore(
                    name="事实正确性",
                    score=1,
                    weight="essential",
                    normalized_score=0.25,
                    reasoning="虚构信息",
                ),
                DimensionScore(
                    name="信息完整性",
                    score=1,
                    weight="important",
                    normalized_score=0.25,
                    reasoning="错误内容",
                ),
                DimensionScore(
                    name="思考正确性",
                    score=1,
                    weight="important",
                    normalized_score=0.25,
                    reasoning="越界推测",
                ),
            ]
    else:
        # 常规用例：检查关键实体覆盖度
        expected = case.expected_answer
        # 基础启发式：若包含关键实体
        key_terms = [
            t
            for t in [
                "Dr. Chen",
                "陈医生",
                "Lily",
                "燕麦拿铁",
                "杭州",
                "豆豆",
                "浙A88888",
                "Lucy",
                "Emma",
                "张伟",
                "花生",
                "蚕豆",
                "alex.zhang",
                "李工",
            ]
            if t in expected
        ]
        matched = [t for t in key_terms if t.lower() in ans.lower()]

        if len(matched) == len(key_terms) and len(key_terms) > 0:
            score_val = 4
        elif len(matched) > 0:
            score_val = 3
        else:
            score_val = 1

        veto = VetoScore(passed=True, reasoning="无明显外部幻觉")
        norm = score_to_normalized(score_val)
        scores = [
            DimensionScore(
                name="事实正确性",
                score=score_val,
                weight="essential",
                normalized_score=norm,
                reasoning="关键词匹配",
            ),
            DimensionScore(
                name="信息完整性",
                score=score_val,
                weight="important",
                normalized_score=norm,
                reasoning="完整性评估",
            ),
            DimensionScore(
                name="思考正确性",
                score=score_val,
                weight="important",
                normalized_score=norm,
                reasoning="逻辑链路评估",
            ),
        ]

    total_score, passed, essential_passed = calculate_case_score(
        scores, veto, strict=strict
    )

    return EvaluationVerdict(
        case_id=case.id,
        strategy=strategy,
        tier=case.tier,
        total_score=total_score,
        passed=passed,
        veto_passed=veto.passed,
        essential_passed=essential_passed,
        dimension_scores=scores,
        veto_score=veto,
        answer=agent_answer,
        latency_ms=latency_ms,
    )
