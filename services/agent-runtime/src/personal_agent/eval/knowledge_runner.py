"""知识库评测运行编排器与 CLI 入口 (Knowledge Runner)。

连接真实 PostgreSQL 数据库（pgvector + pg_jieba + HybridRetriever），
执行真实切块落库、真实四策略召回消融、真实客观指标计算与首错归因。
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Literal

from openai import OpenAI

from personal_agent.db.postgres import close_pg_pool, get_pg_pool
from personal_agent.eval.knowledge_db_seeder import (
    seed_knowledge_corpus,
    teardown_knowledge_corpus,
)
from personal_agent.eval.knowledge_judge import (
    build_knowledge_judge_prompt,
    calculate_knowledge_score,
    compute_retrieval_metrics,
    evaluate_case_from_real_retrieval,
    parse_judge_output,
    score_to_normalized,
)
from personal_agent.eval.knowledge_models import (
    FirstErrorType,
    KnowledgeCapabilityTier,
    KnowledgeDimensionScore,
    KnowledgeEvalCase,
    KnowledgeEvalReport,
    KnowledgeStrategyType,
    KnowledgeVerdict,
    KnowledgeVetoScore,
)
from personal_agent.eval.knowledge_reporter import (
    aggregate_knowledge_matrix,
    render_knowledge_markdown_table,
    save_knowledge_report,
)
from personal_agent.eval.knowledge_strategies import (
    BaseKnowledgeStrategy,
    create_knowledge_strategy,
)
from personal_agent.knowledge.embedder import SemanticMockEmbedder
from personal_agent.knowledge.reranker import MockReranker
from personal_agent.knowledge.retriever import HybridRetriever

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("personal_agent.eval.knowledge_runner")


def load_knowledge_cases(cases_file: Path) -> list[KnowledgeEvalCase]:
    """从 JSON 文件加载并反序列化知识库评测用例清单。"""
    if not cases_file.exists():
        raise FileNotFoundError(f"用例清单文件不存在: {cases_file}")
    with open(cases_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    return [KnowledgeEvalCase.model_validate(item) for item in data]


async def _evaluate_case_live(
    case: KnowledgeEvalCase,
    strategy: BaseKnowledgeStrategy,
    client: OpenAI,
    model_name: str,
) -> KnowledgeVerdict:
    """真实大模型运行与评判流水线（结合真实数据库召回分块）。"""
    retrieved = await strategy.retrieve(case, top_k=3)
    retrieved_ids = [c.id for c in retrieved]

    # 1. 计算客观检索指标
    hit_rate, mrr = compute_retrieval_metrics(
        retrieved_ids, case.gold_chunk_ids
    )

    # 2. 组装 Prompt
    prompt = strategy.assemble_prompt(case, retrieved)

    # 3. 调用模型生成回答
    start_t = time.perf_counter()
    agent_resp = client.chat.completions.create(
        model=model_name,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
    )
    answer = agent_resp.choices[0].message.content or ""
    latency_ms = (time.perf_counter() - start_t) * 1000

    token_usage = {
        "prompt_tokens": agent_resp.usage.prompt_tokens
        if agent_resp.usage
        else 0,
        "completion_tokens": agent_resp.usage.completion_tokens
        if agent_resp.usage
        else 0,
    }

    # 4. 构造 Judge Prompt 并裁决
    judge_prompt = build_knowledge_judge_prompt(
        case=case,
        strategy_type=strategy.strategy_type,
        answer=answer,
        retrieved_chunks=retrieved,
    )

    judge_resp = client.chat.completions.create(
        model=model_name,
        messages=[{"role": "user", "content": judge_prompt}],
        temperature=0.0,
        response_format={"type": "json_object"},
    )
    judge_raw = judge_resp.choices[0].message.content or "{}"
    judge_data = parse_judge_output(judge_raw)

    veto_dict = judge_data.get("veto", {})
    veto_passed = bool(veto_dict.get("passed", True))
    veto_score = KnowledgeVetoScore(
        passed=veto_passed,
        reasoning=str(veto_dict.get("reasoning", "")),
    )

    dim_scores: list[KnowledgeDimensionScore] = []
    case_dim_weights = {d.name: d.weight for d in case.rubric.dimensions}

    for d in judge_data.get("dimensions", []):
        d_name = d.get("name", "")
        d_score = int(d.get("score", 1))
        d_weight = case_dim_weights.get(d_name, "important")
        dim_scores.append(
            KnowledgeDimensionScore(
                name=d_name,
                score=d_score,
                weight=d_weight,
                normalized_score=score_to_normalized(d_score),
                reasoning=str(d.get("reasoning", "")),
            )
        )

    total_score, passed, essential_passed = calculate_knowledge_score(
        dim_scores, veto_score
    )

    # 5. 判定失败首错归因
    first_error: FirstErrorType = "none"
    if not passed:
        if hit_rate < 1.0:
            first_error = "retrieval_miss"
        elif not veto_passed:
            first_error = (
                "unanswerable_violation"
                if case.tier == KnowledgeCapabilityTier.UNANSWERABLE_BOUNDARY
                else "generation_hallucination"
            )
        else:
            first_error = "generation_logic_error"

    return KnowledgeVerdict(
        case_id=case.id,
        strategy=strategy.strategy_type,
        tier=case.tier,
        total_score=total_score,
        passed=passed,
        veto_passed=veto_passed,
        essential_passed=essential_passed,
        dimension_scores=dim_scores,
        veto_score=veto_score,
        retrieved_chunk_ids=retrieved_ids,
        retrieval_hit_rate=hit_rate,
        mrr=mrr,
        first_error=first_error,
        answer=answer,
        latency_ms=round(latency_ms, 2),
        token_usage=token_usage,
    )


async def run_knowledge_eval_async(
    cases: list[KnowledgeEvalCase],
    mode: Literal["scripted", "live"] = "scripted",
    output_dir: Path | None = None,
) -> KnowledgeEvalReport:
    """连接真实 PostgreSQL 执行真实端到端知识库评测。"""
    pool = await get_pg_pool()
    embedder = SemanticMockEmbedder()
    reranker = MockReranker()
    retriever = HybridRetriever(pool=pool, embedder=embedder, reranker=reranker)

    logger.info("正在将评测语料真实写入 PostgreSQL 数据库...")
    tag = f"run_{int(time.time())}"
    _chunk_to_doc, doc_ids = await seed_knowledge_corpus(
        pool, cases, embedder=embedder, prefix_tag=tag
    )

    doc_id_strs = [str(d) for d in doc_ids]

    strategies_types = [
        KnowledgeStrategyType.SPARSE_FTS,
        KnowledgeStrategyType.DENSE_VECTOR,
        KnowledgeStrategyType.HYBRID_RRF,
        KnowledgeStrategyType.HYBRID_RERANK,
    ]

    client = None
    model_name = ""
    if mode == "live":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "运行 live 模式必须配置 OPENAI_API_KEY 环境变量。"
            )
        base_url = os.environ.get("OPENAI_BASE_URL")
        client = OpenAI(api_key=api_key, base_url=base_url)
        model_name = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    verdicts: list[KnowledgeVerdict] = []
    total_runs = len(cases) * len(strategies_types)
    logger.info(
        f"开始知识库真实检索消融评测: 模式={mode}, 用例数={len(cases)}, 策略数={len(strategies_types)}, 总轮次={total_runs}"
    )

    try:
        for case in cases:
            for st in strategies_types:
                strategy = create_knowledge_strategy(
                    strategy_type=st,
                    retriever=retriever,
                    pool=pool,
                    document_ids=doc_id_strs,
                )
                start_t = time.perf_counter()
                retrieved = await strategy.retrieve(case, top_k=3)
                elapsed_ms = (time.perf_counter() - start_t) * 1000

                if mode == "scripted":
                    v = evaluate_case_from_real_retrieval(case, st, retrieved)
                    v.latency_ms = round(elapsed_ms, 2)
                else:
                    assert client is not None
                    v = await _evaluate_case_live(
                        case, strategy, client, model_name
                    )

                verdicts.append(v)
    finally:
        # 严格执行数据库级联清理自愈
        await teardown_knowledge_corpus(pool, doc_ids)
        await close_pg_pool()

    metrics_map = aggregate_knowledge_matrix(verdicts)
    now_iso = datetime.datetime.now(datetime.UTC).isoformat()
    report = KnowledgeEvalReport(
        timestamp=now_iso,
        mode=mode,
        cases_evaluated=len(cases),
        strategies=metrics_map,
        verdicts=verdicts,
    )

    table_str = render_knowledge_markdown_table(metrics_map)
    print("\n" + "=" * 105)
    print("知识库真实数据库检索消融与端到端评估矩阵 (对标《AI Agent 开发实战》表 7-3 与首错归因):")
    print("=" * 105)
    print(table_str)
    print("=" * 105 + "\n")

    if output_dir:
        json_path, md_path = save_knowledge_report(report, output_dir)
        logger.info(f"评测报告已持久化保存:\n- Markdown: {md_path}\n- JSON: {json_path}")

    return report


def run_knowledge_eval(
    cases: list[KnowledgeEvalCase],
    mode: Literal["scripted", "live"] = "scripted",
    output_dir: Path | None = None,
) -> KnowledgeEvalReport:
    """同步兼容入口。"""
    return asyncio.run(
        run_knowledge_eval_async(cases, mode=mode, output_dir=output_dir)
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="PersonalAgent 知识库真实数据库评测运行器"
    )
    parser.add_argument(
        "--cases",
        type=Path,
        default=Path("tests/evals/knowledge_cases.json"),
        help="评测用例清单文件路径",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="启用真实大模型评测模式 (需配置 EVAL_LIVE=1 与 OPENAI_API_KEY)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("tests/evals/reports"),
        help="报告持久化输出目录",
    )
    args = parser.parse_args()

    mode: Literal["scripted", "live"] = "live" if args.live else "scripted"

    if mode == "live" and os.environ.get("EVAL_LIVE") != "1":
        print(
            "提示: 指定了 --live 但 EVAL_LIVE != '1'。遵循 CON-006 规范，切换回确定性 scripted 模式。"
        )
        mode = "scripted"

    cases_path = args.cases
    if not cases_path.is_absolute():
        cur = Path.cwd()
        candidate = cur / cases_path
        if candidate.exists():
            cases_path = candidate

    try:
        cases = load_knowledge_cases(cases_path)
    except FileNotFoundError as exc:
        logger.error(str(exc))
        return 1

    report = run_knowledge_eval(cases, mode=mode, output_dir=args.output_dir)

    rerank_metrics = report.strategies.get(
        KnowledgeStrategyType.HYBRID_RERANK.value
    )
    if rerank_metrics and rerank_metrics.overall_pass_rate < 0.75:
        logger.warning(
            f"生产基线 Hybrid+Rerank 综合通过率低于门禁要求 (75%): {rerank_metrics.overall_pass_rate * 100:.1f}%"
        )
        return 1

    logger.info("知识库评测门禁顺利通过！")
    return 0


if __name__ == "__main__":
    sys.exit(main())
