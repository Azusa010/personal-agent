"""PersonalAgent 知识库神经重排序模块。

支持 bge-reranker-v2-m3 本地 Cross-Encoder 模型与用于单测/降级的 MockReranker。
"""

import logging
import os
import re
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

DEFAULT_BGE_RERANKER_PATH = (
    Path(os.environ["BGE_RERANKER_PATH"])
    if os.environ.get("BGE_RERANKER_PATH")
    else (Path.home() / ".personal-agent" / "models" / "bge-reranker-v2-m3")
)


class ScoredChunk(BaseModel):
    """带有多阶段检索排名的分块模型。"""

    model_config = ConfigDict(extra="allow")

    id: str
    document_id: str
    file_name: str
    source_path: str
    chunk_index: int
    page_numbers: list[int] = Field(default_factory=list)
    heading_path: str | None = None
    raw_text: str
    score: float = 0.0
    dense_rank: int | None = None
    sparse_rank: int | None = None
    rrf_score: float = 0.0
    rerank_score: float | None = None


class BaseReranker(ABC):
    """神经重排序器抽象基类。"""

    @abstractmethod
    async def rerank(
        self,
        query: str,
        candidates: list[ScoredChunk],
        top_k: int = 5,
    ) -> list[ScoredChunk]:
        """对候选 chunks 进行精排，返回得分最高的 top_k 个结果。"""
        ...


class MockReranker(BaseReranker):
    """测试与降级专用的快速重排序器。

    特性：
    - 0 毫秒运算，零外部权重依赖；
    - 依据传入的 rrf_score 降序截断，或保留原始召回顺序；
    - 将 rerank_score 回填为对应得分。
    """

    async def rerank(
        self,
        query: str,
        candidates: list[ScoredChunk],
        top_k: int = 5,
    ) -> list[ScoredChunk]:
        if not candidates:
            return []

        # 模拟 Cross-Encoder 语义交互与时效性判定的精排得分
        eng_tokens = [w.lower() for w in re.findall(r"[a-zA-Z0-9_]{2,}", query)]
        han_blocks = re.findall(r"[\u4e00-\u9fa5]+", query)
        bigrams: list[str] = []
        for block in han_blocks:
            for i in range(len(block) - 1):
                bigrams.append(block[i : i + 2])
        query_features = set(eng_tokens + bigrams)

        for c in candidates:
            base = c.rrf_score if c.rrf_score > 0 else c.score
            target_text = (c.raw_text + " " + (c.heading_path or "")).lower()

            matched_count = sum(1 for feat in query_features if feat in target_text)
            coverage = (matched_count / len(query_features)) if query_features else 0.0

            if coverage > 0.0:
                relevance_factor = 1.0 + (coverage ** 1.2) * 4.0
            else:
                relevance_factor = 0.2

            score = base * relevance_factor

            hpath_lower = (c.heading_path or "").lower()
            is_deprecated = "已废弃" in hpath_lower or "deprecated" in hpath_lower
            is_active = "现行" in hpath_lower or "active" in hpath_lower

            if is_deprecated:
                score *= 0.35
            elif is_active and coverage >= 0.15:
                score *= 1.35

            c.rerank_score = round(score, 6)

        sorted_candidates = sorted(
            candidates,
            key=lambda c: (c.rerank_score if c.rerank_score is not None else 0.0),
            reverse=True,
        )
        selected = sorted_candidates[:top_k]
        for c in selected:
            c.score = c.rerank_score or c.score
        return selected


class BgeReranker(BaseReranker):
    """基于本地 bge-reranker-v2-m3 权重的 Cross-Encoder 重排序器。"""

    def __init__(
        self,
        model_path: Path | str | None = None,
        use_fp16: bool = True,
        device: str | None = None,
    ):
        self.model_path = Path(model_path or DEFAULT_BGE_RERANKER_PATH)
        self.use_fp16 = use_fp16
        self.device = device
        self._model: Any = None

    def _get_model(self) -> Any:
        if self._model is None:
            if not self.model_path.exists():
                raise FileNotFoundError(f"bge-reranker 模型目录不存在: {self.model_path}")
            try:
                from FlagEmbedding import FlagReranker

                logger.info("正在加载本地 bge-reranker 模型: %s", self.model_path)
                self._model = FlagReranker(
                    str(self.model_path),
                    use_fp16=self.use_fp16,
                    device=self.device,
                )
            except ImportError as exc:
                raise RuntimeError(
                    "未安装 FlagEmbedding 库。请执行 `uv add FlagEmbedding` 安装，"
                    "或设置环境变量 KNOWLEDGE_RERANKER_MODE=mock 使用 Mock 模式。"
                ) from exc
        return self._model

    async def rerank(
        self,
        query: str,
        candidates: list[ScoredChunk],
        top_k: int = 5,
    ) -> list[ScoredChunk]:
        if not candidates:
            return []

        model = self._get_model()
        pairs = [[query, c.raw_text] for c in candidates]
        scores = model.compute_score(pairs, normalize=True)
        # scores 可以是单个 float（若只有1条）或 list
        if isinstance(scores, (float, int)):
            scores = [scores]

        for chunk, score in zip(candidates, scores, strict=False):
            chunk.rerank_score = float(score)
            chunk.score = float(score)

        candidates.sort(key=lambda c: (c.rerank_score or 0.0), reverse=True)
        return candidates[:top_k]


def get_reranker(
    mode: str | None = None,
    model_path: Path | str | None = None,
) -> BaseReranker:
    """获取神经重排序器实例（策略工厂模式）。"""
    target_mode = (mode or os.environ.get("KNOWLEDGE_RERANKER_MODE", "auto")).strip().lower()
    path = Path(model_path or DEFAULT_BGE_RERANKER_PATH)

    if target_mode == "mock":
        return MockReranker()
    if target_mode == "local":
        return BgeReranker(model_path=path)

    # auto 模式下探测模型
    effective_path = path
    if not effective_path.exists():
        legacy_path = Path(r"D:\Tools\bge-reranker\models\bge-reranker-v2-m3")
        if legacy_path.exists():
            effective_path = legacy_path

    if effective_path.exists():
        try:
            import FlagEmbedding  # noqa: F401

            return BgeReranker(model_path=effective_path)
        except ImportError:
            logger.warning("FlagEmbedding 未安装，auto 模式自动降级为 MockReranker")
            return MockReranker()

    logger.info("未找到本地 bge-reranker 模型 (%s)，auto 模式自适应启用 MockReranker", path)
    return MockReranker()