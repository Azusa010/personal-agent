"""评测运行编排器与 CLI 入口 (Runner)。

支持两种运行模式：
1. scripted (确定性，CI 默认)：秒级回放基准剧本，零 API Key 依赖，验证评估全链路与打分；
2. live (真实模型)：需配置 EVAL_LIVE=1 与 OPENAI_MODEL，运行真实 Agent 与 LLM-as-a-Judge 评判。
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import os
import sys
import time
from pathlib import Path

from openai import OpenAI

from personal_agent.eval.in_memory_rag import InMemoryRagIndex
from personal_agent.eval.judge import (
    build_judge_prompt,
    calculate_case_score,
    evaluate_case_scripted,
    parse_judge_output,
    score_to_normalized,
)
from personal_agent.eval.models import (
    DimensionScore,
    EvaluationVerdict,
    MemoryEvalCase,
    MemoryEvalReport,
    MemoryStrategyType,
    VetoScore,
)
from personal_agent.eval.reporter import (
    aggregate_eval_matrix,
    render_markdown_table,
    save_eval_report,
)
from personal_agent.eval.strategies import get_strategy

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("personal_agent.eval.runner")


def load_memory_cases(cases_file: Path) -> list[MemoryEvalCase]:
    """从 JSON 文件加载并反序列化评测用例清单。"""
    if not cases_file.exists():
        raise FileNotFoundError(f"用例清单文件不存在: {cases_file}")
    with open(cases_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    return [MemoryEvalCase.model_validate(item) for item in data]


def _simulate_scripted_agent_answer(
    case: MemoryEvalCase,
    strategy_type: MemoryStrategyType,
    index: InMemoryRagIndex,
) -> str:
    """在 Scripted 确定性模式下，根据策略特性模拟真实的回答表现（复现表 7-3 差异）。"""
    is_trap = "password" in case.id or "trap" in case.id
    if is_trap:
        # 纯卡片：卡片中无密码，如实说明
        if strategy_type == MemoryStrategyType.JSON_CARDS:
            return "对不起，根据您的长期记忆记录，未曾提及任何密码，我不知道。"
        elif strategy_type == MemoryStrategyType.PURE_RAG:
            # 纯 RAG：会话中提到路由器/银行卡，偶尔产生侥幸猜想（模拟幻觉否决触发）
            if "wifi" in case.id:
                return "您客厅使用的是华硕路由器，默认密码通常为 admin888。"  # 触发 veto
            return "未在历史记录中检索到密码。"
        else:
            return "根据长期记忆与历史记录，您未曾登记过该密码，出于隐私安全无法提供。"

    # 跨会话隐藏关联题 (cross_session_assoc)
    if case.tier.value == "cross_session_assoc":
        if strategy_type == MemoryStrategyType.JSON_CARDS:
            # 卡片直接呈现提炼好的实体事实
            return case.expected_answer
        elif strategy_type == MemoryStrategyType.PURE_RAG:
            # 纯 RAG 仅检索 Top-3，常丢失多跳实体链条中的上一跳
            hits = index.search(case.question, top_k=2)
            joined = " ".join([h.text for h in hits])
            if "Dr. Chen" in joined and "Lily" not in joined:
                return "儿科医生是 Dr. Chen，但记录中未明确患者与您的关系。"
            return "历史对话中未找到关联信息。"
        else:  # HYBRID
            return case.expected_answer

    # 基础回忆与多会话消歧
    return case.expected_answer


def run_scripted_eval(
    cases: list[MemoryEvalCase],
    strategies: list[MemoryStrategyType] | None = None,
    strict: bool = False,
    include_distractors: bool = False,
) -> MemoryEvalReport:
    """运行 CI 确定性基准评测。"""
    if strategies is None:
        strategies = [
            MemoryStrategyType.JSON_CARDS,
            MemoryStrategyType.PURE_RAG,
            MemoryStrategyType.HYBRID,
        ]

    verdicts: list[EvaluationVerdict] = []

    for case in cases:
        index = InMemoryRagIndex.from_sessions(
            case.sessions, include_distractors=include_distractors
        )
        for st in strategies:
            strat_impl = get_strategy(st)
            # 装配提示词（验证策略 assemble 逻辑无异常）
            _ = strat_impl.assemble_prompt(case, index)

            # 模拟回答
            ans = _simulate_scripted_agent_answer(case, st, index)

            # 评判
            v = evaluate_case_scripted(case, st, ans, latency_ms=15.0, strict=strict)
            verdicts.append(v)

    matrix = aggregate_eval_matrix(verdicts)
    now_str = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H-%M-%S")
    return MemoryEvalReport(
        timestamp=now_str,
        mode="scripted",
        cases_evaluated=len(cases),
        strategies=matrix,
        verdicts=verdicts,
    )


def run_live_eval(
    cases: list[MemoryEvalCase],
    model: str,
    judge_model: str,
    strategies: list[MemoryStrategyType] | None = None,
    strict: bool = False,
    include_distractors: bool = False,
) -> MemoryEvalReport:
    """运行 Live 真实大模型评测。"""
    if strategies is None:
        strategies = [
            MemoryStrategyType.JSON_CARDS,
            MemoryStrategyType.PURE_RAG,
            MemoryStrategyType.HYBRID,
        ]

    base_url = os.environ.get("OPENAI_BASE_URL")
    api_key = os.environ.get("OPENAI_API_KEY")
    client = OpenAI(base_url=base_url, api_key=api_key) if (base_url or api_key) else OpenAI()
    verdicts: list[EvaluationVerdict] = []

    for case in cases:
        index = InMemoryRagIndex.from_sessions(
            case.sessions, include_distractors=include_distractors
        )
        for st in strategies:
            strat_impl = get_strategy(st)
            prompt = strat_impl.assemble_prompt(case, index)

            # 1. 真实 Agent 生成回答
            start_t = time.time()
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
            )
            agent_answer = resp.choices[0].message.content or ""
            latency_ms = (time.time() - start_t) * 1000

            # 2. LLM-as-a-Judge 裁决
            judge_prompt = build_judge_prompt(case, agent_answer)
            judge_resp = client.chat.completions.create(
                model=judge_model,
                messages=[{"role": "user", "content": judge_prompt}],
                response_format={"type": "json_object"},
                temperature=0.0,
            )
            raw_judge = judge_resp.choices[0].message.content or "{}"
            raw_dims, raw_veto = parse_judge_output(raw_judge)

            # 转换维度分
            scores = []
            for d in raw_dims:
                sc = int(d.get("score", 1))
                scores.append(
                    DimensionScore(
                        name=d.get("name", ""),
                        score=sc,
                        weight="essential" if d.get("name") == "事实正确性" else "important",
                        normalized_score=score_to_normalized(sc),
                        reasoning=d.get("reasoning", ""),
                    )
                )

            veto_score = VetoScore(
                passed=bool(raw_veto.get("passed", True)),
                reasoning=raw_veto.get("reasoning", ""),
            )

            total_score, passed, essential_passed = calculate_case_score(
                scores, veto_score, strict=strict
            )

            verdict = EvaluationVerdict(
                case_id=case.id,
                strategy=st,
                tier=case.tier,
                total_score=total_score,
                passed=passed,
                veto_passed=veto_score.passed,
                essential_passed=essential_passed,
                dimension_scores=scores,
                veto_score=veto_score,
                answer=agent_answer,
                latency_ms=latency_ms,
            )
            verdicts.append(verdict)
            logger.info(
                "Case [%s] Strategy [%s] -> Passed: %s, TotalScore: %.2f",
                case.id,
                st.value,
                passed,
                total_score,
            )

    matrix = aggregate_eval_matrix(verdicts)
    now_str = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H-%M-%S")
    return MemoryEvalReport(
        timestamp=now_str,
        mode="live",
        cases_evaluated=len(cases),
        strategies=matrix,
        verdicts=verdicts,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="用户记忆与知识库评测运行工具")
    parser.add_argument(
        "--cases",
        type=str,
        default=str(Path(__file__).parents[5] / "tests" / "evals" / "memory_cases.json"),
        help="评测用例 JSON 路径",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=str(Path(__file__).parents[5] / "tests" / "evals" / "reports"),
        help="报告输出目录",
    )
    parser.add_argument("--live", action="store_true", help="是否以 Live 真实模型运行")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="开启严苛门禁模式（要求 essential 达 4 分优秀且总分 >= 0.85）",
    )
    parser.add_argument(
        "--distractors",
        action="store_true",
        help="在 RAG 向量库中注入背景干扰对话，检验召回鲁棒性",
    )
    parser.add_argument(
        "--filter-case",
        type=str,
        default=None,
        help="仅运行特定 case id（支持逗号分隔多个）",
    )
    parser.add_argument(
        "--strategies",
        type=str,
        default=None,
        help="仅运行指定策略，逗号分隔（如 json_cards,pure_rag,hybrid）",
    )
    args = parser.parse_args()

    cases_path = Path(args.cases)
    out_dir = Path(args.output_dir)

    all_cases = load_memory_cases(cases_path)

    # 1. 过滤用例 (优先读 CLI 参数，其次读 EVAL_CASES 环境变量)
    case_filter_raw = args.filter_case or os.environ.get("EVAL_CASES")
    if case_filter_raw:
        case_ids = {c.strip() for c in case_filter_raw.split(",") if c.strip()}
        all_cases = [c for c in all_cases if c.id in case_ids]
        if not all_cases:
            logger.error("未找到匹配的用例: %s", case_filter_raw)
            return 1

    # 2. 过滤策略 (优先读 CLI 参数，其次读 EVAL_STRATEGIES 环境变量)
    strat_filter_raw = args.strategies or os.environ.get("EVAL_STRATEGIES")
    selected_strategies = None
    if strat_filter_raw:
        strat_names = [s.strip() for s in strat_filter_raw.split(",") if s.strip()]
        selected_strategies = [MemoryStrategyType(s) for s in strat_names]

    is_live = args.live or os.environ.get("EVAL_LIVE") == "1"
    is_strict = args.strict or os.environ.get("EVAL_STRICT") == "1"
    include_distractors = args.distractors or os.environ.get("EVAL_DISTRACTORS") == "1"
    model = os.environ.get("OPENAI_MODEL", "gpt-4o")
    judge_model = os.environ.get("OPENAI_JUDGE_MODEL", model)

    logger.info(
        "开始运行用户记忆评测: 共 %d 条用例，模式: %s，严苛门禁: %s，干扰注入: %s",
        len(all_cases),
        "LIVE" if is_live else "SCRIPTED",
        is_strict,
        include_distractors,
    )

    if is_live:
        report = run_live_eval(
            all_cases,
            model=model,
            judge_model=judge_model,
            strategies=selected_strategies,
            strict=is_strict,
            include_distractors=include_distractors,
        )
    else:
        report = run_scripted_eval(
            all_cases,
            strategies=selected_strategies,
            strict=is_strict,
            include_distractors=include_distractors,
        )

    json_p, md_p = save_eval_report(report, out_dir)
    print("\n" + "=" * 80)
    print(render_markdown_table(report.strategies))
    print("=" * 80)
    print(f"\n[OK] 评测报告已保存至:\n  JSON: {json_p}\n  Markdown: {md_p}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
