"""RAPTOR 递归抽象树与跨文档宏观对比检索单元测试。"""

import pytest

from personal_agent.knowledge.raptor import (
    RaptorNode,
    RaptorTree,
    build_raptor_tree,
    cluster_chunks_by_similarity,
    cosine_similarity,
    retrieve_raptor_context,
)


def test_cosine_similarity():
    """验证余弦相似度计算与零向量边界。"""
    # 相同向量 -> 1.0
    assert pytest.approx(cosine_similarity([1.0, 0.0], [1.0, 0.0])) == 1.0
    # 正交向量 -> 0.0
    assert pytest.approx(cosine_similarity([1.0, 0.0], [0.0, 1.0])) == 0.0
    # 相反向量 -> -1.0
    assert pytest.approx(cosine_similarity([1.0, 0.0], [-1.0, 0.0])) == -1.0
    # 零向量安全返回 0.0
    assert cosine_similarity([0.0, 0.0], [1.0, 1.0]) == 0.0
    # 维度不一致安全返回 0.0
    assert cosine_similarity([1.0], [1.0, 2.0]) == 0.0


def test_cluster_chunks_by_similarity_boundary():
    """验证聚类分组边界：空列表、单项、target_clusters <= 1 或大于节点数。"""
    # 1. 空输入
    assert cluster_chunks_by_similarity([], target_clusters=2) == []

    # 2. 单项输入
    single = [("c1", [1.0, 0.0])]
    assert cluster_chunks_by_similarity(single, target_clusters=2) == [["c1"]]

    # 3. target_clusters <= 1: 全部合并为一个簇
    items = [("c1", [1.0, 0.0]), ("c2", [0.0, 1.0])]
    clusters = cluster_chunks_by_similarity(items, target_clusters=1)
    assert len(clusters) == 1
    assert set(clusters[0]) == {"c1", "c2"}

    # 4. items 数量 <= target_clusters: 每个独立成簇
    clusters_each = cluster_chunks_by_similarity(items, target_clusters=5)
    assert len(clusters_each) == 2
    all_assigned = {cid for cl in clusters_each for cid in cl}
    assert all_assigned == {"c1", "c2"}


def test_cluster_chunks_by_similarity_semantic_grouping():
    """验证语义聚类：空间相近的向量被正确聚合到同一簇，无遗漏无空簇。"""
    # 构造两个明确分立的语义簇：
    # 簇 1: 围绕 [1.0, 0.0, 0.0]
    # 簇 2: 围绕 [0.0, 1.0, 0.0]
    items = [
        ("sse_1", [0.99, 0.05, 0.0]),
        ("sse_2", [0.95, 0.10, 0.0]),
        ("avx_1", [0.05, 0.98, 0.0]),
        ("avx_2", [0.10, 0.95, 0.0]),
    ]

    clusters = cluster_chunks_by_similarity(items, target_clusters=2)

    # 1. 簇数量为 2
    assert len(clusters) == 2

    # 2. 每个簇非空
    assert all(len(c) > 0 for c in clusters)

    # 3. 每一个 item 恰好出现一次
    all_ids = [cid for c in clusters for cid in c]
    assert sorted(all_ids) == ["avx_1", "avx_2", "sse_1", "sse_2"]

    # 4. 语义相近的归入同一簇
    sse_cluster = next(c for c in clusters if "sse_1" in c)
    assert "sse_2" in sse_cluster
    avx_cluster = next(c for c in clusters if "avx_1" in c)
    assert "avx_2" in avx_cluster


def test_retrieve_raptor_context():
    """验证跨层级检索打分、层级加权与 Top-K 截断。"""
    tree = RaptorTree(tree_id="test_cpu_tree")

    # Layer 0 微观节点
    tree.nodes["leaf_sse"] = RaptorNode(
        id="leaf_sse",
        text="SSE 采用 128 位 XMM 寄存器",
        layer=0,
        embedding=[1.0, 0.0, 0.0],
    )
    tree.nodes["leaf_arm"] = RaptorNode(
        id="leaf_arm",
        text="ARM NEON 向量指令集",
        layer=0,
        embedding=[0.0, 1.0, 0.0],
    )
    # Layer 1 宏观摘要节点
    tree.nodes["summary_x86"] = RaptorNode(
        id="summary_x86",
        text="x86 向量指令集演进概览：从 128 位 SSE 发展到 256 位 AVX",
        layer=1,
        children_ids=["leaf_sse"],
        embedding=[0.8, 0.0, 0.6],  # 与 leaf_sse 方向相近
    )

    query_vec = [1.0, 0.0, 0.0]

    # 1. 无加权检索：leaf_sse 相似度最高 (1.0)，其次为 summary_x86 (0.8)
    results = retrieve_raptor_context(query_vec, tree, top_k=2)
    assert len(results) == 2
    assert results[0][0].id == "leaf_sse"
    assert pytest.approx(results[0][1], 0.01) == 1.0
    assert results[1][0].id == "summary_x86"
    assert pytest.approx(results[1][1], 0.01) == 0.8

    # 2. 层级加权检索：给予 Layer 1 (宏观摘要) 1.5 倍权重加权
    # summary_x86 得分: 0.8 * 1.5 = 1.2 > 1.0 (leaf_sse)
    boosted_results = retrieve_raptor_context(
        query_vec,
        tree,
        top_k=2,
        layer_weights={0: 1.0, 1: 1.5},
    )
    assert boosted_results[0][0].id == "summary_x86"
    assert pytest.approx(boosted_results[0][1], 0.01) == 1.2


@pytest.mark.asyncio
async def test_build_raptor_tree_integration():
    """验证端到端 build_raptor_tree 异步构建递归抽象树。"""
    leaf_chunks = [
        {"id": "c1", "text": "SSE 128 位指令"},
        {"id": "c2", "text": "SSE2 增强"},
        {"id": "c3", "text": "AVX 256 位指令"},
        {"id": "c4", "text": "AVX2 整数向量"},
    ]

    async def mock_embed(texts: list[str]) -> list[list[float]]:
        # 简单确定性向量：前两条在 [1, 0] 方向，后两条在 [0, 1] 方向
        vecs = []
        for t in texts:
            if "SSE" in t:
                vecs.append([1.0, 0.0])
            elif "AVX" in t:
                vecs.append([0.0, 1.0])
            else:
                vecs.append([0.7, 0.7])
        return vecs

    async def mock_summarize(texts: list[str]) -> str:
        return f"摘要: 聚合了 {len(texts)} 条内容 -> {' | '.join(texts)}"

    tree = await build_raptor_tree(
        tree_id="simd_tree",
        leaf_chunks=leaf_chunks,
        embed_fn=mock_embed,
        summarize_fn=mock_summarize,
        max_layers=2,
        reduction_ratio=0.5,
    )

    # 验证树结构
    assert tree.tree_id == "simd_tree"
    assert tree.layers == 2
    # Layer 0 有 4 个叶子
    layer_0_nodes = tree.get_layer_nodes(0)
    assert len(layer_0_nodes) == 4
    # Layer 1 有聚类摘要节点
    layer_1_nodes = tree.get_layer_nodes(1)
    assert len(layer_1_nodes) >= 1
    for p_node in layer_1_nodes:
        assert p_node.layer == 1
        assert len(p_node.children_ids) > 0


@pytest.mark.asyncio
async def test_sse_avx_cross_document_comparison():
    """跨文档宏观对比测试（CPU 指令集演进分析）。

    场景说明：
    知识库中录入了 4 份关于 Intel SIMD 的详细微观文档（SSE, SSE2, AVX, AVX-512）。
    用户发起宏观跨文档对比查询：
    "比较 SSE 与 AVX 在寄存器位宽与架构设计上有何本质不同？"
    """
    corpus = [
        {
            "id": "doc_sse",
            "text": "SSE (Streaming SIMD Extensions) 引入了 8 个 128 位 XMM 寄存器，支持 4 个单精度浮点并行计算。",
        },
        {
            "id": "doc_sse2",
            "text": "SSE2 扩展了对双精度浮点数和整数向量的支持，成为 x86-64 架构的标准基础。",
        },
        {
            "id": "doc_avx",
            "text": "AVX 将寄存器扩展为 16 个 256 位 YMM 寄存器（低 128 位兼容 XMM），并引入 VEX 前缀的三操作数非破坏性语法。",
        },
        {
            "id": "doc_avx512",
            "text": "AVX-512 进一步将寄存器拓宽至 32 个 512 位 ZMM 寄存器，并引入 opmask 掩码寄存器（k0-k7）进行条件计算。",
        },
    ]

    async def embed_fn(texts: list[str]) -> list[list[float]]:
        res = []
        for t in texts:
            # 语义方向映射
            if "SSE" in t and "AVX" not in t:
                res.append([1.0, 0.1, 0.0])
            elif "AVX" in t and "SSE" not in t:
                res.append([0.1, 1.0, 0.0])
            else:
                # 宏观综合摘要或对比
                res.append([0.7, 0.7, 0.1])
        return res

    async def summarize_fn(texts: list[str]) -> str:
        return f"【指令集宏观聚合概览】包含: {' ; '.join(texts)}"

    tree = await build_raptor_tree(
        tree_id="intel_simd_evolution",
        leaf_chunks=corpus,
        embed_fn=embed_fn,
        summarize_fn=summarize_fn,
        max_layers=2,
        reduction_ratio=0.5,
    )

    # 宏观对比查询向量（综合对比方向）
    query_vector = [0.6, 0.6, 0.0]

    # 检索时倾向于获取高层宏观摘要 (layer 1 加权 1.3)
    results = retrieve_raptor_context(
        query_embedding=query_vector,
        tree=tree,
        top_k=3,
        layer_weights={0: 1.0, 1: 1.3},
    )

    # 1. 验证检索结果不为空且在 Top-3 内
    assert len(results) > 0

    # 2. 验证高相关节点中命中了 Layer 1 的宏观概览
    hit_layers = {node.layer for node, _ in results}
    assert 1 in hit_layers

    # 3. 验证返回的文本覆盖了 128 位与 256 位核心技术事实
    combined_texts = " ".join(node.text for node, _ in results)
    assert "128 位" in combined_texts or "128位" in combined_texts
    assert "256 位" in combined_texts or "256位" in combined_texts
    assert len(results) > 0  # 基础底线断言保留
