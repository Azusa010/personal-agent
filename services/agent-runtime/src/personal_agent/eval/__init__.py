"""用户记忆与知识库多维 Rubric 评测模块。"""

from personal_agent.eval.in_memory_rag import InMemoryRagIndex
from personal_agent.eval.judge import (
    build_judge_prompt,
    calculate_case_score,
    evaluate_case_scripted,
    parse_judge_output,
    score_to_normalized,
)
from personal_agent.eval.models import (
    CapabilityTier,
    DimensionScore,
    EvaluationVerdict,
    MemoryEvalCase,
    MemoryEvalReport,
    MemoryStrategyType,
    RubricDimension,
    StrategyMetrics,
    TierMetrics,
    VetoDimension,
    VetoScore,
)
from personal_agent.eval.reporter import (
    aggregate_eval_matrix,
    render_markdown_table,
    save_eval_report,
)
from personal_agent.eval.strategies import (
    BaseMemoryStrategy,
    HybridStrategy,
    JsonCardsStrategy,
    PureRagStrategy,
    get_strategy,
)

__all__ = [
    "BaseMemoryStrategy",
    "CapabilityTier",
    "DimensionScore",
    "EvaluationVerdict",
    "HybridStrategy",
    "InMemoryRagIndex",
    "JsonCardsStrategy",
    "MemoryEvalCase",
    "MemoryEvalReport",
    "MemoryStrategyType",
    "PureRagStrategy",
    "RubricDimension",
    "StrategyMetrics",
    "TierMetrics",
    "VetoDimension",
    "VetoScore",
    "aggregate_eval_matrix",
    "build_judge_prompt",
    "calculate_case_score",
    "evaluate_case_scripted",
    "get_strategy",
    "parse_judge_output",
    "render_markdown_table",
    "save_eval_report",
    "score_to_normalized",
]
