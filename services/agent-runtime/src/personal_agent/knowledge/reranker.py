"""PersonalAgent 知识库神经重排序模块。

支持 bge-reranker-v2-m3 本地 Cross-Encoder 模型与用于单测/降级的 MockReranker。
"""

import logging
import os
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

DEFAULT_BGE_RERANKER_PATH = Path(
    os.environ.get(
        "BGE_RERANKER_PATH",
        r"D:\Tools\bge-reranker\models\bge-reranker-v2-m3",
    )
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

        # 按 rrf_score 降序排序，若没有则按原有顺序
        sorted_candidates = sorted(
            candidates,
            key=lambda c: (c.rrf_score, c.score),
            reverse=True,
        )
        selected = sorted_candidates[:top_k]
        for c in selected:
            if c.rerank_score is None:
                c.rerank_score = c.rrf_score or c.score
            c.score = c.rerank_score
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
        self._fallback = MockReranker()

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

        try:
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
        except (RuntimeError, OSError, ValueError, TypeError, KeyError) as exc:
            logger.warning("BgeReranker 计算异常，平滑降级至 MockReranker: %s", exc)
            return await self._fallback.rerank(query, candidates, top_k)


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

    # auto 模式下探测
    if path.exists():
        try:
            import FlagEmbedding  # noqa: F401

            return BgeReranker(model_path=path)
        except ImportError:
            logger.warning("FlagEmbedding 未安装，降级为 MockReranker")
            return MockReranker()
    return MockReranker()
