"""用户记忆与知识库评测数据模型契约 (Pydantic Models)。

定义评测用例、多维 Rubric 结构、加权评分及表 7-3 统计报告模型。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from personal_agent.protocol.models import UserMemoryCard


class CapabilityTier(str, Enum):
    """能力分层。"""

    BASIC_RECALL = "basic_recall"  # 基础回忆
    DISAMBIGUATION = "disambiguation"  # 多会话消歧
    CROSS_SESSION_ASSOC = "cross_session_assoc"  # 跨会话隐藏关联


class MemoryStrategyType(str, Enum):
    """记忆方案类型。"""

    JSON_CARDS = "json_cards"  # 纯 Advanced JSON Cards (常驻上下文)
    PURE_RAG = "pure_rag"  # 纯 RAG (历史会话切块按需检索)
    HYBRID = "hybrid"  # 混合系统 (卡片常驻 + 对话按需检索)


class RubricDimension(BaseModel):
    """单个打分维度。"""

    model_config = ConfigDict(extra="allow")

    name: str  # 维度名，如 "事实正确性"
    weight: Literal["essential", "important"]  # essential (50%), important (25%)
    scoring: dict[str, str]  # 4 优秀 / 3 良好 / 2 及格 / 1 不及格 标准说明


class VetoDimension(BaseModel):
    """一票否决维度。"""

    model_config = ConfigDict(extra="allow")

    name: str = "幻觉检测"
    weight: Literal["veto"] = "veto"
    scoring: dict[str, str] = Field(
        default_factory=lambda: {
            "pass": "所有信息均可溯源到历史对话或记忆卡片",
            "fail": "编造了不存在的信息",
        }
    )


class CaseRubric(BaseModel):
    """用例的完整 Rubric。"""

    model_config = ConfigDict(extra="allow")

    dimensions: list[RubricDimension]
    veto: VetoDimension
    edge_cases: list[str] = Field(default_factory=list)


class SessionMessage(BaseModel):
    """跨会话中的单条消息。"""

    model_config = ConfigDict(extra="allow")

    role: str
    content: str


class MemoryEvalCase(BaseModel):
    """记忆与知识库评测用例定义。"""

    model_config = ConfigDict(extra="allow")

    id: str
    tier: CapabilityTier
    question: str
    expected_answer: str
    sessions: list[list[SessionMessage]]
    memory_cards: list[UserMemoryCard | dict[str, Any]] = Field(default_factory=list)
    rubric: CaseRubric


class DimensionScore(BaseModel):
    """单维度评分结果。"""

    model_config = ConfigDict(extra="allow")

    name: str
    score: int  # 1..4
    weight: str
    normalized_score: float  # 4->1.0, 3->0.75, 2->0.5, 1->0.25
    reasoning: str = ""


class VetoScore(BaseModel):
    """一票否决检测结果。"""

    model_config = ConfigDict(extra="allow")

    passed: bool
    reasoning: str = ""


class EvaluationVerdict(BaseModel):
    """单条用例单套方案的最终裁决结果。"""

    model_config = ConfigDict(extra="allow")

    case_id: str
    strategy: MemoryStrategyType
    tier: CapabilityTier
    total_score: float  # 0.0 .. 1.0 (veto 触发时强制为 0.0)
    passed: bool  # 是否通过门禁
    veto_passed: bool
    essential_passed: bool
    dimension_scores: list[DimensionScore]
    veto_score: VetoScore
    answer: str = ""
    latency_ms: float = 0.0
    token_usage: dict[str, int] = Field(default_factory=dict)


class TierMetrics(BaseModel):
    """单一能力分层的统计指标。"""

    model_config = ConfigDict(extra="allow")

    total: int = 0
    passed: int = 0
    pass_rate: float = 0.0
    avg_score: float = 0.0
    veto_triggers: int = 0


class StrategyMetrics(BaseModel):
    """单套记忆机制的综合评估矩阵（对齐表 7-3）。"""

    model_config = ConfigDict(extra="allow")

    strategy: MemoryStrategyType
    overall_total: int = 0
    overall_passed: int = 0
    overall_pass_rate: float = 0.0
    overall_avg_score: float = 0.0
    veto_triggers_total: int = 0
    avg_latency_ms: float = 0.0
    by_tier: dict[CapabilityTier, TierMetrics] = Field(default_factory=dict)


class MemoryEvalReport(BaseModel):
    """完整评测运行产出的持久化报告。"""

    model_config = ConfigDict(extra="allow")

    timestamp: str
    mode: Literal["scripted", "live"]
    cases_evaluated: int
    strategies: dict[str, StrategyMetrics]
    verdicts: list[EvaluationVerdict]
