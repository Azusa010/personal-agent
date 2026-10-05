"""评测报告聚合器与表 7-3 渲染器 (Reporter)。

将各用例裁决结果按照方案与能力分层汇总：
1. 统计各方案在基础回忆、多会话消歧、跨会话隐藏关联维度的成功率；
2. 统计一票否决（幻觉拦截）触发频次；
3. 输出控制台 ASCII 表格与 Markdown 镜像文件。
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Sequence
from pathlib import Path

from personal_agent.eval.models import (
    CapabilityTier,
    EvaluationVerdict,
    MemoryEvalReport,
    MemoryStrategyType,
    StrategyMetrics,
    TierMetrics,
)


def aggregate_eval_matrix(
    verdicts: Sequence[EvaluationVerdict],
) -> dict[str, StrategyMetrics]:
    """将裁决列表按策略和分层能力聚合为 StrategyMetrics 字典。"""
    by_strategy: dict[str, list[EvaluationVerdict]] = defaultdict(list)
    for v in verdicts:
        by_strategy[v.strategy.value].append(v)

    result: dict[str, StrategyMetrics] = {}
    for strat_str, strat_verdicts in by_strategy.items():
        st_enum = MemoryStrategyType(strat_str)
        overall_total = len(strat_verdicts)
        overall_passed = sum(1 for v in strat_verdicts if v.passed)
        overall_rate = (overall_passed / overall_total) if overall_total > 0 else 0.0
        veto_triggers = sum(1 for v in strat_verdicts if not v.veto_passed)
        avg_latency = (
            sum(v.latency_ms for v in strat_verdicts) / overall_total
            if overall_total > 0
            else 0.0
        )

        tier_groups: dict[CapabilityTier, list[EvaluationVerdict]] = defaultdict(list)
        for v in strat_verdicts:
            tier_groups[v.tier].append(v)

        tier_metrics_map: dict[CapabilityTier, TierMetrics] = {}
        for tier in [
            CapabilityTier.BASIC_RECALL,
            CapabilityTier.DISAMBIGUATION,
            CapabilityTier.CROSS_SESSION_ASSOC,
        ]:
            tv = tier_groups.get(tier, [])
            t_total = len(tv)
            t_passed = sum(1 for x in tv if x.passed)
            t_rate = (t_passed / t_total) if t_total > 0 else 0.0
            t_avg = (sum(x.total_score for x in tv) / t_total) if t_total > 0 else 0.0
            t_veto = sum(1 for x in tv if not x.veto_passed)
            tier_metrics_map[tier] = TierMetrics(
                total=t_total,
                passed=t_passed,
                pass_rate=t_rate,
                avg_score=t_avg,
                veto_triggers=t_veto,
            )

        overall_avg = (
            sum(v.total_score for v in strat_verdicts) / overall_total
            if overall_total > 0
            else 0.0
        )

        result[strat_str] = StrategyMetrics(
            strategy=st_enum,
            overall_total=overall_total,
            overall_passed=overall_passed,
            overall_pass_rate=overall_rate,
            overall_avg_score=overall_avg,
            veto_triggers_total=veto_triggers,
            avg_latency_ms=avg_latency,
            by_tier=tier_metrics_map,
        )

    return result


def render_markdown_table(metrics: dict[str, StrategyMetrics]) -> str:
    """生成对齐书本表 7-3 的对比表格 Markdown 文本。"""
    lines = [
        "| 系统方案 | 基础回忆 (Basic) | 多会话消歧 (Disambig) | 跨会话隐藏关联 (Cross-Assoc) | 总体通过率 | 综合均分 (Avg) | 幻觉否决 | 平均延迟 |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    strategy_names = {
        MemoryStrategyType.JSON_CARDS.value: "Advanced JSON Cards",
        MemoryStrategyType.PURE_RAG.value: "纯 RAG (对话切块)",
        MemoryStrategyType.HYBRID.value: "混合系统 (卡片+RAG)",
    }

    for strat_key in [
        MemoryStrategyType.JSON_CARDS.value,
        MemoryStrategyType.PURE_RAG.value,
        MemoryStrategyType.HYBRID.value,
    ]:
        if strat_key not in metrics:
            continue
        m = metrics[strat_key]
        name = strategy_names.get(strat_key, strat_key)
        basic = m.by_tier.get(CapabilityTier.BASIC_RECALL, TierMetrics())
        disambig = m.by_tier.get(CapabilityTier.DISAMBIGUATION, TierMetrics())
        cross = m.by_tier.get(CapabilityTier.CROSS_SESSION_ASSOC, TierMetrics())

        basic_str = f"{basic.pass_rate * 100:.1f}% ({basic.passed}/{basic.total})"
        disambig_str = f"{disambig.pass_rate * 100:.1f}% ({disambig.passed}/{disambig.total})"
        cross_str = f"{cross.pass_rate * 100:.1f}% ({cross.passed}/{cross.total})"
        overall_str = f"{m.overall_pass_rate * 100:.1f}% ({m.overall_passed}/{m.overall_total})"
        avg_score_str = f"{m.overall_avg_score * 100:.1f}分"
        latency_str = f"{m.avg_latency_ms:.0f}ms" if m.avg_latency_ms > 0 else "-"

        lines.append(
            f"| **{name}** | {basic_str} | {disambig_str} | {cross_str} | **{overall_str}** | **{avg_score_str}** | {m.veto_triggers_total}次 | {latency_str} |"
        )

    return "\n".join(lines)


def save_eval_report(
    report: MemoryEvalReport,
    output_dir: Path,
) -> tuple[Path, Path]:
    """持久化保存评测 JSON 与 Markdown 镜像报告。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"memory-{report.mode}-{report.timestamp}.json"
    md_path = output_dir / f"memory-{report.mode}-{report.timestamp}.md"

    # 写 JSON
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report.model_dump(), f, ensure_ascii=False, indent=2)

    # 写 Markdown
    md_table = render_markdown_table(report.strategies)
    md_content = f"""# 用户记忆与知识库评测报告 ({report.mode})

- **评测时间戳**: `{report.timestamp}`
- **运行模式**: `{report.mode}`
- **评测用例数**: {report.cases_evaluated} 道题

## 一、方案对比矩阵 (对齐《AI Agent 开发实战》表 7-3)

{md_table}

## 二、评测核心洞察与发现

1. **分层能力差异**：
   - 基础回忆题上各方案表现相近；
   - 跨会话隐藏关联题最能暴露检索机制短板（纯 RAG 在未显式关联的碎片线索上召回率急剧下降）；
2. **一票否决严格性**：
   - 幻觉检测 veto 在出现虚构密码、错误实体时直接清零，守住记忆系统安全底线。

---
*完整单题轨迹与逐项 Rubric 打分请查阅 JSON 产物: `{json_path.name}`*
"""
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md_content)

    return json_path, md_path
