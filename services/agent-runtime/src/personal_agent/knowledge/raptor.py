"""RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval) 树状抽象引擎

针对长篇领域知识（如 CPU 指令集架构、长篇规范手册），
提供自底向上的语义聚类、递归高层抽象以及跨层级（宏观全景 + 微观细节）多维检索。
"""

import logging
import math
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)


def cosine_similarity(v1: list[float], v2: list[float]) -> float:
    """计算两个实数向量的余弦相似度。"""
    if len(v1) != len(v2) or not v1:
        return 0.0
    dot = sum(a * b for a, b in zip(v1, v2))
    norm1 = math.sqrt(sum(a * a for a in v1))
    norm2 = math.sqrt(sum(b * b for b in v2))
    if norm1 == 0.0 or norm2 == 0.0:
        return 0.0
    return dot / (norm1 * norm2)


class RaptorNode(BaseModel):
    """RAPTOR 递归抽象树中的单个节点（可为叶子 chunk 或高层 summary）。"""

    model_config = ConfigDict(extra="allow")

    id: str = Field(description="节点唯一 ID")
    text: str = Field(description="节点文本（叶子内容或聚类抽象摘要）")
    layer: int = Field(default=0, description="层级：0 为最底层叶子，1+ 为高阶摘要")
    children_ids: list[str] = Field(default_factory=list, description="子节点 ID 列表")
    embedding: list[float] | None = Field(default=None, description="向量嵌入")
    metadata: dict[str, Any] = Field(default_factory=dict, description="来源与元数据")


class RaptorTree(BaseModel):
    """包含所有层级节点的 RAPTOR 展开索引树。"""

    model_config = ConfigDict(extra="allow")

    tree_id: str
    nodes: dict[str, RaptorNode] = Field(default_factory=dict)
    layers: int = 1

    @property
    def total_nodes(self) -> int:
        return len(self.nodes)

    def get_layer_nodes(self, layer: int) -> list[RaptorNode]:
        return [node for node in self.nodes.values() if node.layer == layer]


def cluster_chunks_by_similarity(
    items: list[tuple[str, list[float]]],
    target_clusters: int,
) -> list[list[str]]:
    """将文本节点基于向量嵌入余弦相似度聚类分组（自底向上构建 RAPTOR 树的核心）。

    契约要求：
    1. 边界防御：
       - 若 items 为空，返回空列表 `[]`；
       - 若 items 数量 <= target_clusters 或 target_clusters <= 1：
         若 target_clusters <= 1，所有 item 归入同一个簇 `[[id1, id2, ...]]`；
         若 items 数量 <= target_clusters，每个 item 独立成簇 `[[id1], [id2], ...]`;
    2. 聚类算法：
       - 初始种子选择：按确定性步长从 items 中挑选 `target_clusters` 个向量作为初始质心；
       - 迭代分配：对每个 item，计算其与所有质心的余弦相似度，归入相似度最高（最近）的质心所属簇；
       - 质心更新：计算每个簇中所有成员向量的均值向量，作为新质心；
       - 迭代 3 轮以使聚类趋于稳定；
    3. 结果保证与孤儿块防御：
       - 输入的每一个 item_id 必须且仅能出现在一个簇中；
       - 不允许产生空簇（空簇应过滤抛弃）；
       - 返回每个簇的 item_id 列表，如 `[["c0", "c1"], ["c2", "c3"]]`。

    :param items: (item_id, embedding_vector) 列表
    :param target_clusters: 期望聚合的目标聚类数
    :returns: 聚类分组列表
    """
    if items is None or not items:
        return []
    if target_clusters <= 1:
        return [[item[0] for item in items]]
    if len(items) <= target_clusters:
        return [[item[0]] for item in items]

    dim = len(items[0][1])
    step = max(1, len(items) // target_clusters)
    centroids = [list(items[i * step][1]) for i in range(target_clusters)]
    clusters: list[list[tuple[str, list[float]]]] = [[] for _ in range(target_clusters)]
    for _ in range(3):
        clusters = [[] for _ in range(target_clusters)]
        for item_id, vec in items:
            best_sim = -float("inf")
            best_c  = 0
            for c_idx,c_vec in enumerate(centroids):
                sim = cosine_similarity(vec, c_vec)
                if sim > best_sim:
                    best_sim = sim
                    best_c = c_idx
            clusters[best_c].append((item_id, vec))
        # 更新质心
        for c_idx, cluster in enumerate(clusters):
            if not cluster:
                continue
            new_centroid = [0.0] * dim
            for _, vec in cluster:
                for d in range(dim):
                    new_centroid[d] += vec[d]
            count = len(cluster)
            centroids[c_idx] = [x / count for x in new_centroid]
    # 返回聚类结果
    return [[item[0] for item in cluster] for cluster in clusters if cluster]

def retrieve_raptor_context(
    query_embedding: list[float],
    tree: RaptorTree,
    top_k: int = 5,
    layer_weights: dict[int, float] | None = None,
) -> list[tuple[RaptorNode, float]]:
    """跨层级检索 RAPTOR 树节点，支持高层宏观概览与底层微观细节的自适应匹配。

    契约要求：
    1. 遍历树中所有已具有 `embedding` 的节点；
    2. 计算节点 embedding 与 query_embedding 的余弦相似度；
    3. 层级加权（支持偏向宏观抽象或微观细节）：
       若提供了 `layer_weights`（如 `{0: 1.0, 1: 1.3}`），
       `score = base_similarity * layer_weights.get(node.layer, 1.0)`；
       若未提供则加权系数默认为 1.0；
    4. 排序与截断：按最终 score 降序排序，返回前 `top_k` 个 `(RaptorNode, score)` 元组。

    :param query_embedding: 查询文本的嵌入向量
    :param tree: 待检索的 RAPTOR 树
    :param top_k: 返回结果数量限制
    :param layer_weights: 各层级得分加权字典 {layer: weight}
    :returns: 按得分从高到低排序的 (节点, 得分) 列表
    """
    scored_nodes: list[tuple[RaptorNode, float]] = []

    for node in tree.nodes.values():
        if node.embedding is None:
            continue
        base_sim = cosine_similarity(query_embedding, node.embedding)
        weight = 1.0
        if layer_weights and node.layer in layer_weights:
            weight = layer_weights[node.layer]
        score = base_sim * weight
        scored_nodes.append((node, score))

    # 按得分降序排序并返回前 top_k 个
    scored_nodes.sort(key=lambda x: x[1], reverse=True)
    return scored_nodes[:top_k]

async def build_raptor_tree(
    tree_id: str,
    leaf_chunks: list[dict[str, Any]],
    embed_fn: Callable[[list[str]], Awaitable[list[list[float]]]],
    summarize_fn: Callable[[list[str]], Awaitable[str]],
    max_layers: int = 3,
    reduction_ratio: float = 0.5,
) -> RaptorTree:
    """自底向上构建完整的 RAPTOR 递归抽象树。

    :param tree_id: 树标识
    :param leaf_chunks: 叶子文本块列表（每项包含 "id", "text", 可选 "metadata"）
    :param embed_fn: 批量向量嵌入函数
    :param summarize_fn: 聚类多文本抽象摘要生成函数
    :param max_layers: 最大递归树深度
    :param reduction_ratio: 每层聚类压缩比例（0.5 表示下一层聚类数约为本层节点数的 50%）
    :returns: 构建完成的 RaptorTree 实例
    """
    if not leaf_chunks:
        return RaptorTree(tree_id=tree_id)

    tree = RaptorTree(tree_id=tree_id)

    # 1. 批量计算叶子节点向量
    leaf_texts = [str(c["text"]) for c in leaf_chunks]
    leaf_vectors = await embed_fn(leaf_texts)

    current_layer_nodes: list[RaptorNode] = []
    for chunk, vec in zip(leaf_chunks, leaf_vectors):
        node = RaptorNode(
            id=str(chunk["id"]),
            text=str(chunk["text"]),
            layer=0,
            embedding=vec,
            metadata=dict(chunk.get("metadata", {})),
        )
        tree.nodes[node.id] = node
        current_layer_nodes.append(node)

    current_layer = 0

    # 2. 递归自底向上聚类与抽象
    while current_layer < max_layers - 1 and len(current_layer_nodes) > 1:
        next_layer = current_layer + 1
        target_clusters = max(1, math.ceil(len(current_layer_nodes) * reduction_ratio))

        # 聚类项准备 (id, vector)
        items = [
            (node.id, node.embedding)
            for node in current_layer_nodes
            if node.embedding is not None
        ]
        clusters = cluster_chunks_by_similarity(items, target_clusters)

        next_layer_nodes: list[RaptorNode] = []
        cluster_texts_to_summarize: list[list[str]] = []
        cluster_children_map: list[list[str]] = []

        for cluster_ids in clusters:
            if not cluster_ids:
                continue
            child_texts = [tree.nodes[cid].text for cid in cluster_ids]
            cluster_texts_to_summarize.append(child_texts)
            cluster_children_map.append(cluster_ids)

        if not cluster_texts_to_summarize:
            break

        # 批量或顺次生成各聚类的高层摘要
        summaries: list[str] = []
        for texts in cluster_texts_to_summarize:
            summary = await summarize_fn(texts)
            summaries.append(summary)

        # 为高层摘要批量生成向量
        summary_vectors = await embed_fn(summaries)

        for idx, (summary, s_vec, children) in enumerate(
            zip(summaries, summary_vectors, cluster_children_map)
        ):
            parent_id = f"raptor_{tree_id}_L{next_layer}_N{idx}"
            node = RaptorNode(
                id=parent_id,
                text=summary,
                layer=next_layer,
                children_ids=children,
                embedding=s_vec,
                metadata={"source_layer": current_layer, "cluster_size": len(children)},
            )
            tree.nodes[node.id] = node
            next_layer_nodes.append(node)

        current_layer_nodes = next_layer_nodes
        current_layer = next_layer

    tree.layers = current_layer + 1
    return tree
