"""PersonalAgent 知识库向量嵌入模块。

支持 bge-m3 本地模型与用于单元测试/CI 的确定性 MockEmbedder。
"""

import hashlib
import logging
import math
import os
import random
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

DEFAULT_BGE_M3_PATH = (
    Path(os.environ["BGE_M3_PATH"])
    if os.environ.get("BGE_M3_PATH")
    else (Path.home() / ".personal-agent" / "models" / "bge-m3")
)
EMBEDDING_DIM = 1024


class EmbeddingOutput(BaseModel):
    """单条文本的嵌入表示，同时包含稠密与稀疏结果。"""

    model_config = ConfigDict(extra="allow")

    dense: list[float] = Field(description="1024 维稠密单位向量")
    sparse: dict[str, float] | None = Field(
        default=None, description="稀疏词权重字典 {token_or_term: weight}"
    )


class BaseEmbedder(ABC):
    """向量嵌入器抽象基类。"""

    @abstractmethod
    async def embed_query(self, text: str) -> EmbeddingOutput:
        """为单条检索查询生成嵌入表示。"""
        ...

    @abstractmethod
    async def embed_documents(self, texts: list[str]) -> list[EmbeddingOutput]:
        """批量为文档/切块生成嵌入表示。"""
        ...


class MockEmbedder(BaseEmbedder):
    """单测与 CI 环境使用的确定性向量生成器。

    特性：
    - 0 毫秒生成、零外部依赖（无需 GPU 或下载模型权重）；
    - 严格输出 1024 维归一化单位向量（模长为 1.0）；
    - 相同文本输出完全相同的稠密与稀疏向量，不同文本输出不同向量。
    """

    def __init__(self, dim: int = EMBEDDING_DIM):
        self.dim = dim

    def _generate_deterministic_vector(self, text: str) -> list[float]:
        # 使用 sha256 作为伪随机种子生成确定性浮点向量
        seed = int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")
        rng = random.Random(seed)
        raw = [rng.gauss(0, 1.0) for _ in range(self.dim)]
        norm = math.sqrt(sum(x * x for x in raw))
        if norm == 0:
            raw[0] = 1.0
            norm = 1.0
        return [round(x / norm, 6) for x in raw]

    def _generate_sparse_weights(self, text: str) -> dict[str, float]:
        tokens = [t.strip().lower() for t in text.split() if t.strip()]
        if not tokens:
            tokens = [text.strip()] if text.strip() else ["empty"]
        counts: dict[str, int] = {}
        for t in tokens:
            counts[t] = counts.get(t, 0) + 1
        total = sum(counts.values())
        return {k: round(v / total, 4) for k, v in counts.items()}

    async def embed_query(self, text: str) -> EmbeddingOutput:
        dense = self._generate_deterministic_vector(text)
        sparse = self._generate_sparse_weights(text)
        return EmbeddingOutput(dense=dense, sparse=sparse)

    async def embed_documents(self, texts: list[str]) -> list[EmbeddingOutput]:
        return [await self.embed_query(t) for t in texts]


class SemanticMockEmbedder(BaseEmbedder):
    """用于测试与真实数据库检索消融的语义特征投影嵌入器。

    特性：
    - 0 毫秒生成、零外部依赖；
    - 基于中文二元字符切分 (bi-gram) 与英文 token 散列投影到 1024 维空间；
    - 在 PostgreSQL pgvector (dense_embedding <=> $1) 下产生真实的余弦相似度区分度：
      文本具有语义/词汇重合时，距离显著缩小；完全无关文本距离接近 1.0。
    """

    def __init__(self, dim: int = EMBEDDING_DIM):
        self.dim = dim

    def _embed(self, text: str) -> list[float]:
        tokens = [t.strip().lower() for t in text.split() if t.strip()]
        bigrams = [
            text[i : i + 2]
            for i in range(len(text) - 1)
            if not text[i : i + 2].isspace()
        ]
        all_features = tokens + bigrams
        vec = [0.0] * self.dim
        for feat in all_features:
            idx = (
                int(hashlib.md5(feat.encode("utf-8")).hexdigest()[:8], 16)
                % self.dim
            )
            vec[idx] += 1.0
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [round(x / norm, 6) for x in vec]

    def _generate_sparse_weights(self, text: str) -> dict[str, float]:
        tokens = [t.strip().lower() for t in text.split() if t.strip()]
        if not tokens:
            tokens = [text.strip()] if text.strip() else ["empty"]
        counts: dict[str, int] = {}
        for t in tokens:
            counts[t] = counts.get(t, 0) + 1
        total = sum(counts.values())
        return {k: round(v / total, 4) for k, v in counts.items()}

    async def embed_query(self, text: str) -> EmbeddingOutput:
        dense = self._embed(text)
        sparse = self._generate_sparse_weights(text)
        return EmbeddingOutput(dense=dense, sparse=sparse)

    async def embed_documents(self, texts: list[str]) -> list[EmbeddingOutput]:
        return [await self.embed_query(t) for t in texts]


class BgeM3Embedder(BaseEmbedder):
    """基于本地 BAAI/bge-m3 权重的双编码嵌入器。"""

    def __init__(
        self,
        model_path: Path | str | None = None,
        use_fp16: bool = True,
        device: str | None = None,
    ):
        self.model_path = Path(model_path or DEFAULT_BGE_M3_PATH)
        self.use_fp16 = use_fp16
        self.device = device
        self._model: Any = None

    def _get_model(self) -> Any:
        if self._model is None:
            if not self.model_path.exists():
                raise FileNotFoundError(f"bge-m3 模型目录不存在: {self.model_path}")
            try:
                from FlagEmbedding import BGEM3FlagModel

                logger.info("正在加载本地 bge-m3 模型: %s", self.model_path)
                self._model = BGEM3FlagModel(
                    str(self.model_path),
                    use_fp16=self.use_fp16,
                    device=self.device,
                )
            except ImportError as exc:
                raise RuntimeError(
                    "未安装 FlagEmbedding 库。请执行 `uv add FlagEmbedding` 安装，"
                    "或设置环境变量 KNOWLEDGE_EMBEDDER_MODE=mock 使用 Mock 模式。"
                ) from exc
        return self._model

    async def embed_query(self, text: str) -> EmbeddingOutput:
        model = self._get_model()
        output = model.encode(
            [text],
            return_dense=True,
            return_sparse=True,
            return_colbert_vecs=False,
        )
        dense_vec = output["dense_vecs"][0].tolist()
        sparse_vec = output.get("lexical_weights", [{}])[0]
        sparse_dict = {str(k): float(v) for k, v in sparse_vec.items()}
        return EmbeddingOutput(dense=dense_vec, sparse=sparse_dict)

    async def embed_documents(self, texts: list[str]) -> list[EmbeddingOutput]:
        if not texts:
            return []
        model = self._get_model()
        output = model.encode(
            texts,
            return_dense=True,
            return_sparse=True,
            return_colbert_vecs=False,
        )
        dense_list = output["dense_vecs"].tolist()
        sparse_list = output.get("lexical_weights", [{} for _ in texts])
        results: list[EmbeddingOutput] = []
        for dense_vec, sparse_vec in zip(dense_list, sparse_list, strict=False):
            sparse_dict = {str(k): float(v) for k, v in sparse_vec.items()}
            results.append(EmbeddingOutput(dense=dense_vec, sparse=sparse_dict))
        return results


def get_embedder(
    mode: str | None = None,
    model_path: Path | str | None = None,
) -> BaseEmbedder:
    """获取向量嵌入器实例（策略工厂模式）。
    """
    target_mode = (mode or os.environ.get("KNOWLEDGE_EMBEDDER_MODE", "auto")).strip().lower()
    path = Path(model_path or DEFAULT_BGE_M3_PATH)
    if target_mode == "mock":
        logger.info("使用 MockEmbedder 模式")
        return MockEmbedder()

    if target_mode in ("mock_semantic", "semantic_mock", "semantic"):
        logger.info("使用 SemanticMockEmbedder 模式")
        return SemanticMockEmbedder()

    if target_mode == "local":
        return BgeM3Embedder(model_path=path)

    # auto 模式下探测模型
    effective_path = path
    if not effective_path.exists() or not effective_path.is_dir():
        legacy_path = Path(r"D:\Tools\bge")
        if legacy_path.exists() and legacy_path.is_dir():
            effective_path = legacy_path

    if not effective_path.exists() or not effective_path.is_dir():
        raise FileNotFoundError(
            f"bge-m3 模型目录不存在: {path}。请设置环境变量 BGE_M3_PATH，"
            "或将权重下载到 ~/.personal-agent/models/bge-m3，"
            "或设置环境变量 KNOWLEDGE_EMBEDDER_MODE=mock 使用测试模式。"
        )

    return BgeM3Embedder(model_path=effective_path)
