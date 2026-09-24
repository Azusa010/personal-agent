"""知识库向量嵌入器单元测试。"""

import asyncio
import math
from pathlib import Path

from personal_agent.knowledge.embedder import (
    BgeM3Embedder,
    MockEmbedder,
    get_embedder,
)


def test_mock_embedder_dimension_and_norm():
    """验证 MockEmbedder 生成 1024 维归一化单位向量。"""

    async def _run():
        embedder = MockEmbedder()
        output = await embedder.embed_query("深入理解 AI Agent")

        assert len(output.dense) == 1024
        # 模长校验
        norm = math.sqrt(sum(x * x for x in output.dense))
        assert abs(norm - 1.0) < 1e-4
        assert output.sparse is not None
        assert len(output.sparse) > 0

    asyncio.run(_run())


def test_mock_embedder_deterministic():
    """验证 MockEmbedder 具有确定性且模长为 1.0。"""

    async def _run():
        embedder = MockEmbedder()
        t1 = "混合检索算法"
        t2 = "混合检索算法"
        t3 = "不同主题文本"

        out1 = await embedder.embed_query(t1)
        out2 = await embedder.embed_query(t2)
        out3 = await embedder.embed_query(t3)

        assert out1.dense == out2.dense
        assert out1.dense != out3.dense
        norm1 = math.sqrt(sum(x * x for x in out1.dense))
        assert abs(norm1 - 1.0) < 1e-4

    asyncio.run(_run())


def test_embed_documents_batch():
    """验证批量文档嵌入生成。"""

    async def _run():
        embedder = MockEmbedder()
        docs = ["段落 1", "段落 2", "段落 3"]
        results = await embedder.embed_documents(docs)

        assert len(results) == 3
        for res in results:
            assert len(res.dense) == 1024
            assert res.sparse is not None

    asyncio.run(_run())


def test_get_embedder_strategy_dispatch():
    """验证 Embedder 策略工厂根据模式分发实例。"""
    # 1. 显式 mock 模式
    mock_inst = get_embedder(mode="mock")
    assert isinstance(mock_inst, MockEmbedder)

    # 2. 显式 local 模式必须返回 BgeM3Embedder 且 model_path 正确
    custom_path = Path("D:/Tools/bge")
    local_inst = get_embedder(mode="local", model_path=custom_path)
    assert isinstance(local_inst, BgeM3Embedder)
    assert local_inst.model_path == custom_path

    # 3. 环境变量覆盖测试
    import os

    old_env = os.environ.get("KNOWLEDGE_EMBEDDER_MODE")
    try:
        os.environ["KNOWLEDGE_EMBEDDER_MODE"] = "mock"
        env_inst = get_embedder()
        assert isinstance(env_inst, MockEmbedder)
    finally:
        if old_env is None:
            os.environ.pop("KNOWLEDGE_EMBEDDER_MODE", None)
        else:
            os.environ["KNOWLEDGE_EMBEDDER_MODE"] = old_env
