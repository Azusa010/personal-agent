"""知识库评估系统核心单元与集成测试。

覆盖：
1. 评测清单 knowledge_cases.json 的反序列化与契约完整性校验；
2. 4 种检索架构方案 (Sparse/Dense/Hybrid/Rerank) 检索与上下文装配行为；
3. Scale AI 四准则多维 Rubric 归一化与加权计算 (essential 50%, important 各 25%)；
4. 虚构幻觉一票否决 (veto fail -> 强制清零与判定失败)；
5. 门禁阻断 (essential 未及格时，即使总分达标依然判 Fail)；
6. 表 7-3 统计矩阵聚合与 Markdown 报告渲染；
7. 确定性脚本模式 (scripted) 全链路端到端评测冒烟。
"""

import socket
from pathlib import Path

import pytest

from personal_agent.db.postgres import get_postgres_config
from personal_agent.eval.knowledge_judge import (
    calculate_knowledge_score,
    score_to_normalized,
)
from personal_agent.eval.knowledge_models import (
    KnowledgeCapabilityTier,
    KnowledgeDimensionScore,
    KnowledgeEvalCase,
    KnowledgeStrategyType,
    KnowledgeVetoScore,
)
from personal_agent.eval.knowledge_runner import (
    load_knowledge_cases,
    run_knowledge_eval,
)
from personal_agent.eval.knowledge_strategies import (
    SparseFtsStrategy,
    format_chunks_xml,
)


def _get_cases_path() -> Path:
    cur = Path(__file__).resolve()
    for parent in cur.parents:
        target = parent / "tests" / "evals" / "knowledge_cases.json"
        if target.exists():
            return target
    raise FileNotFoundError("未在任何上级目录找到 tests/evals/knowledge_cases.json")


def test_load_knowledge_cases_manifest():
    """验证评测清单文件能被正常加载且符合 Pydantic 模型契约。"""
    cases_path = _get_cases_path()
    cases = load_knowledge_cases(cases_path)

    assert len(cases) >= 12, f"知识库黄金用例数应不少于 12 条，当前: {len(cases)}"

    # 验证四大能力分层全覆盖
    tiers = {c.tier for c in cases}
    assert KnowledgeCapabilityTier.SINGLE_HOP in tiers
    assert KnowledgeCapabilityTier.MULTI_HOP in tiers
    assert KnowledgeCapabilityTier.TEMPORAL_CONFLICT in tiers
    assert KnowledgeCapabilityTier.UNANSWERABLE_BOUNDARY in tiers

    # 验证每个用例的语料与 Rubric 契约
    for case in cases:
        assert isinstance(case, KnowledgeEvalCase)
        assert len(case.id) > 0
        assert len(case.question) > 0
        assert len(case.expected_answer) > 0
        assert case.rubric.veto.weight == "veto"
        assert len(case.rubric.dimensions) == 3

        essential_dims = [
            d for d in case.rubric.dimensions if d.weight == "essential"
        ]
        important_dims = [
            d for d in case.rubric.dimensions if d.weight == "important"
        ]
        assert len(essential_dims) == 1, (
            f"用例 {case.id} 必须包含且仅包含 1 个 essential 维度"
        )
        assert len(important_dims) == 2, (
            f"用例 {case.id} 必须包含 2 个 important 维度"
        )

        for chunk in case.corpus:
            assert chunk.id.strip() != ""
            assert chunk.text.strip() != ""
            assert chunk.status in ("active", "deprecated")


def test_knowledge_prompt_assembly_contract():
    """验证 Prompt 组装与 XML 上下文格式化契约。"""
    cases_path = _get_cases_path()
    cases = load_knowledge_cases(cases_path)
    sample_case = next(
        c for c in cases if c.tier == KnowledgeCapabilityTier.MULTI_HOP
    )

    # 1. 验证有分块时的 XML 组装
    sample_chunks = sample_case.corpus[:2]
    formatted = format_chunks_xml(sample_chunks)
    assert f'id="{sample_chunks[0].id}"' in formatted
    assert f'title="{sample_chunks[0].title}"' in formatted
    assert sample_chunks[0].text.strip() in formatted

    # 2. 验证空分块时的友好降级提示
    empty_formatted = format_chunks_xml([])
    assert "未检索到相关知识库分块" in empty_formatted

    # 3. 验证完整上下文 Prompt 组装结构
    strat = SparseFtsStrategy(retriever=None, pool=None)  # type: ignore
    prompt = strat.assemble_prompt(sample_case, sample_chunks)
    assert sample_case.question in prompt
    assert "<knowledge_context>" in prompt
    assert "</knowledge_context>" in prompt
    assert "核心执行准则（不可违反）" in prompt



def test_rubric_scoring_and_normalization():
    """验证四档制映射与加权打分公式计算。"""
    assert score_to_normalized(4) == 1.0
    assert score_to_normalized(3) == 0.75
    assert score_to_normalized(2) == 0.50
    assert score_to_normalized(1) == 0.25

    # 4 优秀, 4 优秀, 4 优秀 -> 1.0*0.5 + 1.0*0.25 + 1.0*0.25 = 1.0
    dims = [
        KnowledgeDimensionScore(
            name="事实忠实度与证据溯源",
            score=4,
            weight="essential",
            normalized_score=1.0,
        ),
        KnowledgeDimensionScore(
            name="回答相关性与完整性",
            score=4,
            weight="important",
            normalized_score=1.0,
        ),
        KnowledgeDimensionScore(
            name="逻辑消歧与推导",
            score=4,
            weight="important",
            normalized_score=1.0,
        ),
    ]
    veto = KnowledgeVetoScore(passed=True)
    score, passed, essential_passed = calculate_knowledge_score(dims, veto)
    assert score == 1.0
    assert passed is True
    assert essential_passed is True

    # 良好: 3, 3, 3 -> 0.75*0.5 + 0.75*0.25 + 0.75*0.25 = 0.75 >= 0.60 -> 通过
    dims_good = [
        KnowledgeDimensionScore(
            name="事实忠实度与证据溯源",
            score=3,
            weight="essential",
            normalized_score=0.75,
        ),
        KnowledgeDimensionScore(
            name="回答相关性与完整性",
            score=3,
            weight="important",
            normalized_score=0.75,
        ),
        KnowledgeDimensionScore(
            name="逻辑消歧与推导",
            score=3,
            weight="important",
            normalized_score=0.75,
        ),
    ]
    score_g, passed_g, _ = calculate_knowledge_score(dims_good, veto)
    assert score_g == 0.75
    assert passed_g is True


def test_veto_failure_strictly_clears_score():
    """验证一票否决：一旦触发虚构幻觉，总分直接清零且判定不通过。"""
    dims = [
        KnowledgeDimensionScore(
            name="事实忠实度与证据溯源",
            score=4,
            weight="essential",
            normalized_score=1.0,
        ),
        KnowledgeDimensionScore(
            name="回答相关性与完整性",
            score=4,
            weight="important",
            normalized_score=1.0,
        ),
        KnowledgeDimensionScore(
            name="逻辑消歧与推导",
            score=4,
            weight="important",
            normalized_score=1.0,
        ),
    ]
    # 触发幻觉否决
    veto_fail = KnowledgeVetoScore(
        passed=False, reasoning="检测到凭空捏造未收录密码"
    )
    score, passed, essential_passed = calculate_knowledge_score(dims, veto_fail)
    assert score == 0.0
    assert passed is False
    assert essential_passed is False


def test_essential_blocker_gate():
    """验证门禁阻断：essential 不及格时，即使总分达标依然判定 Fail。"""
    # 设定 essential=1 (0.25*0.5=0.125), important=4, important=4 (0.25+0.25=0.50) -> raw = 0.625 >= 0.60
    dims = [
        KnowledgeDimensionScore(
            name="事实忠实度与证据溯源",
            score=1,
            weight="essential",
            normalized_score=0.25,
        ),
        KnowledgeDimensionScore(
            name="回答相关性与完整性",
            score=4,
            weight="important",
            normalized_score=1.0,
        ),
        KnowledgeDimensionScore(
            name="逻辑消歧与推导",
            score=4,
            weight="important",
            normalized_score=1.0,
        ),
    ]
    veto_pass = KnowledgeVetoScore(passed=True)
    score, passed, essential_passed = calculate_knowledge_score(dims, veto_pass)
    assert score == 0.625
    assert essential_passed is False
    assert passed is False, "essential 维度不及格必须阻断通过"


def _is_pg_reachable() -> bool:
    cfg = get_postgres_config()
    try:
        with socket.create_connection((cfg["host"], cfg["port"]), timeout=0.5):
            return True
    except OSError:
        return False


@pytest.mark.skipif(
    not _is_pg_reachable(),
    reason="PostgreSQL 未运行 (127.0.0.1:5432)：这条要真把语料写进 pgvector",
)
def test_scripted_eval_pipeline_e2e(tmp_path: Path):
    """端到端验证知识库评测脚本化运行器与报告生成。"""
    cases_path = _get_cases_path()
    cases = load_knowledge_cases(cases_path)

    report = run_knowledge_eval(cases, mode="scripted", output_dir=tmp_path)

    assert report.cases_evaluated == len(cases)
    assert len(report.strategies) == 4
    assert len(report.verdicts) == len(cases) * 4

    # 验证报告文件生成
    json_report = tmp_path / "knowledge_eval_report.json"
    md_report = tmp_path / "knowledge_eval_report.md"
    assert json_report.exists()
    assert md_report.exists()

    # 验证消融对比效应：Hybrid+Rerank 方案成功率达到生产基线 (>= 90%)
    rerank_metrics = report.strategies[KnowledgeStrategyType.HYBRID_RERANK.value]
    dense_metrics = report.strategies[KnowledgeStrategyType.DENSE_VECTOR.value]

    assert rerank_metrics.overall_pass_rate >= 0.90
    assert rerank_metrics.by_tier[
        KnowledgeCapabilityTier.TEMPORAL_CONFLICT
    ].pass_rate == 1.0
    assert (
        dense_metrics.by_tier[
            KnowledgeCapabilityTier.MULTI_HOP
        ].pass_rate
        < 1.0
    )

    # 验证 Markdown 包含表 7-3 表头
    md_text = md_report.read_text(encoding="utf-8")
    assert "检索架构方案" in md_text
    assert "单跳事实" in md_text
    assert "多跳综合" in md_text
    assert "版本消歧" in md_text
    assert "拒答红线" in md_text
    assert "生产全流水线 (Hybrid+Rerank)" in md_text

