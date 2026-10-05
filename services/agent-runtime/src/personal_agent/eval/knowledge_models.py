"""知识库评估系统数据模型契约 (Pydantic Models)。

定义知识库评测用例、4 种检索架构、4 大黄金能力分层、客观检索指标 (HitRate/MRR)、
Scale AI 四准则多维 Rubric 与首错失败归因 (First Error Localization)。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class KnowledgeCapabilityTier(str, Enum):
    """知识库能力分层（对标教材与实际工业界基准）。"""

    SINGLE_HOP = "single_hop"  # 单跳事实精确召回
    MULTI_HOP = "multi_hop"  # 跨分块/跨文档多跳综合
    TEMPORAL_CONFLICT = "temporal_conflict"  # 版本时效更替与冲突消歧
    UNANSWERABLE_BOUNDARY = "unanswerable_boundary"  # 无依据诚实拒答与防幻觉边界


class KnowledgeStrategyType(str, Enum):
    """四种知识检索架构方案（对齐表 7-3 与消融实验）。"""

    SPARSE_FTS = "sparse_fts"  # 纯关键词/稀疏全文检索 (pg_jieba)
    DENSE_VECTOR = "dense_vector"  # 纯稠密向量检索 (pgvector)
    HYBRID_RRF = "hybrid_rrf"  # 混合检索 + RRF 倒数排名融合（无重排）
    HYBRID_RERANK = "hybrid_rerank"  # 完整混合检索 + 跨编码器神经重排序（生产级基准）


class KnowledgeChunkData(BaseModel):
    """知识库切块数据定义。"""

    model_config = ConfigDict(extra="allow")

    id: str
    title: str
    text: str
    source_path: str = ""
    page_numbers: list[int] = Field(default_factory=list)
    version: str | None = None
    status: Literal["active", "deprecated"] = "active"
    keywords: list[str] = Field(default_factory=list)
    dense_vector: list[float] | None = None


class KnowledgeRubricDimension(BaseModel):
    """单个打分维度。"""

    model_config = ConfigDict(extra="allow")

    name: str  # 维度名，如 "事实忠实度与证据溯源"
    weight: Literal["essential", "important"]  # essential (50%), important (25%)
    scoring: dict[str, str]  # 4 优秀 / 3 良好 / 2 及格 / 1 不及格 标准说明


class KnowledgeVetoDimension(BaseModel):
    """一票否决维度（虚构幻觉拦截）。"""

    model_config = ConfigDict(extra="allow")

    name: str = "虚构幻觉拦截"
    weight: Literal["veto"] = "veto"
    scoring: dict[str, str] = Field(
        default_factory=lambda: {
            "pass": "所有论断均可溯源到检索分块；对知识库未记录信息诚实说明不知",
            "fail": "编造了知识库中不存在的参数、接口、版本或事实，或对无解问题强行伪造回答",
        }
    )


class KnowledgeCaseRubric(BaseModel):
    """知识库用例的完整 Rubric。"""

    model_config = ConfigDict(extra="allow")

    dimensions: list[KnowledgeRubricDimension]
    veto: KnowledgeVetoDimension = Field(default_factory=KnowledgeVetoDimension)
    edge_cases: list[str] = Field(default_factory=list)


class KnowledgeEvalCase(BaseModel):
    """知识库评测用例定义。"""

    model_config = ConfigDict(extra="allow")

    id: str
    tier: KnowledgeCapabilityTier
    question: str
    expected_answer: str
    corpus: list[KnowledgeChunkData] = Field(default_factory=list)
    gold_chunk_ids: list[str] = Field(
        default_factory=list, description="正确回答所需黄金分块 ID 清单"
    )
    rubric: KnowledgeCaseRubric
    metadata: dict[str, Any] = Field(default_factory=dict)


class KnowledgeDimensionScore(BaseModel):
    """单维度评分结果。"""

    model_config = ConfigDict(extra="allow")

    name: str
    score: int  # 1..4
    weight: str
    normalized_score: float  # 4->1.0, 3->0.75, 2->0.5, 1->0.25
    reasoning: str = ""


class KnowledgeVetoScore(BaseModel):
    """一票否决检测结果。"""

    model_config = ConfigDict(extra="allow")

    passed: bool
    reasoning: str = ""


FirstErrorType = Literal[
    "none",
    "retrieval_miss",  # 检索阶段漏召回黄金分块 (Harness 问题)
    "rerank_demotion",  # 重排序将废弃分块置于有效分块之上或降权 (Harness 问题)
    "generation_logic_error",  # 证据已在上下文，但模型推理/归纳错误 (模型能力问题)
    "generation_hallucination",  # 模型编造未在分块中出现的内容 (模型能力问题)
    "unanswerable_violation",  # 无依据题型下强行编造回答 (模型能力问题)
]


class KnowledgeVerdict(BaseModel):
    """单条用例单套检索策略的最终裁决结果。"""

    model_config = ConfigDict(extra="allow")

    case_id: str
    strategy: KnowledgeStrategyType
    tier: KnowledgeCapabilityTier
    total_score: float  # 0.0 .. 1.0 (veto 触发时强制为 0.0)
    passed: bool  # 是否通过门禁
    veto_passed: bool
    essential_passed: bool
    dimension_scores: list[KnowledgeDimensionScore]
    veto_score: KnowledgeVetoScore
    retrieved_chunk_ids: list[str] = Field(default_factory=list)
    retrieval_hit_rate: float = 1.0  # 黄金分块在检索结果中的召回率 (HitRate@K)
    mrr: float = 0.0  # 黄金分块在检索结果中的倒数排名 (Mean Reciprocal Rank)
    first_error: FirstErrorType = "none"  # 首错失败归因定位
    answer: str = ""
    latency_ms: float = 0.0
    token_usage: dict[str, int] = Field(default_factory=dict)


class KnowledgeTierMetrics(BaseModel):
    """单一能力分层的统计指标。"""

    model_config = ConfigDict(extra="allow")

    total: int = 0
    passed: int = 0
    pass_rate: float = 0.0
    avg_score: float = 0.0
    avg_hit_rate: float = 0.0
    avg_mrr: float = 0.0
    veto_triggers: int = 0
    retrieval_failures: int = 0


class KnowledgeStrategyMetrics(BaseModel):
    """单套检索机制的综合评估矩阵（对齐表 7-3）。"""

    model_config = ConfigDict(extra="allow")

    strategy: KnowledgeStrategyType
    overall_total: int = 0
    overall_passed: int = 0
    overall_pass_rate: float = 0.0
    overall_avg_score: float = 0.0
    avg_hit_rate: float = 0.0  # 平均召回率 HitRate@K
    avg_mrr: float = 0.0  # 平均倒数排名 MRR
    veto_triggers_total: int = 0
    retrieval_failures_total: int = 0  # 归因为 Harness 检索阶段失败的次数
    generation_failures_total: int = 0  # 归因为模型生成/推理阶段失败的次数
    avg_latency_ms: float = 0.0
    by_tier: dict[KnowledgeCapabilityTier, KnowledgeTierMetrics] = Field(
        default_factory=dict
    )


class KnowledgeEvalReport(BaseModel):
    """完整知识库评测运行产出的持久化报告。"""

    model_config = ConfigDict(extra="allow")

    timestamp: str
    mode: Literal["scripted", "live"]
    cases_evaluated: int
    strategies: dict[str, KnowledgeStrategyMetrics]
    verdicts: list[KnowledgeVerdict]
