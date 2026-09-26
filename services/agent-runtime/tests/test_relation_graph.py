"""OpenViking 知识图谱关系边引擎 (RelationGraph) 单元测试。"""

import json
from pathlib import Path

from personal_agent.knowledge.relation_graph import (
    RelationEdge,
    RelationGraph,
)


def test_relation_graph_load_and_save(tmp_path: Path):
    """验证 relations.jsonl 加载、保存以及跳过损坏行。"""
    jsonl_path = tmp_path / "relations.jsonl"

    valid_line = json.dumps(
        {
            "from": "viking://knowledge/cpu/avx.md",
            "to": "viking://knowledge/cpu/sse.md",
            "predicate": "extends",
            "label": "演进扩展",
            "evidence": ["AVX 扩展了 SSE 寄存器"],
            "confidence": 0.95,
            "createdAt": "2026-09-26T08:00:00Z",
            "updatedAt": "2026-09-26T08:00:00Z",
        },
        ensure_ascii=False,
    )
    corrupted_line = "this is not a valid json line {broken}"

    jsonl_path.write_text(f"{valid_line}\n{corrupted_line}\n", encoding="utf-8")

    graph = RelationGraph(jsonl_path)

    # 1. 验证成功解析 1 条合法边并跳过损坏行
    assert graph.edge_count == 1
    edge = graph._edges[
        ("viking://knowledge/cpu/avx.md", "viking://knowledge/cpu/sse.md")
    ]
    assert edge.from_uri == "viking://knowledge/cpu/avx.md"
    assert edge.to_uri == "viking://knowledge/cpu/sse.md"
    assert edge.predicate == "extends"

    # 2. 验证 save 后文件仅含合法记录
    graph.save()
    lines = [
        line.strip()
        for line in jsonl_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(lines) == 1
    saved_data = json.loads(lines[0])
    assert saved_data["from"] == "viking://knowledge/cpu/avx.md"
    assert saved_data["to"] == "viking://knowledge/cpu/sse.md"


def test_add_or_update_edge(tmp_path: Path):
    """验证在位去重更新与新增行为 (add_or_update_edge)。"""
    jsonl_path = tmp_path / "relations.jsonl"
    graph = RelationGraph(jsonl_path)
    assert graph.edge_count == 0

    created_time = "2026-09-26T00:00:00Z"
    edge1 = RelationEdge(
        from_uri="viking://knowledge/cpu/avx.md",
        to_uri="viking://knowledge/cpu/sse.md",
        predicate="extends",
        label="初始演进",
        evidence=["初版证据"],
        confidence=0.8,
        createdAt=created_time,
        updatedAt=created_time,
    )

    # 1. 新增第一条边 -> 应返回 True
    is_new = graph.add_or_update_edge(edge1)
    assert is_new is True
    assert graph.edge_count == 1

    # 验证落盘内容
    persisted_lines = [
        line.strip()
        for line in jsonl_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(persisted_lines) == 1
    row1 = json.loads(persisted_lines[0])
    assert row1["from"] == "viking://knowledge/cpu/avx.md"
    assert row1["to"] == "viking://knowledge/cpu/sse.md"
    assert row1["label"] == "初始演进"
    assert row1["createdAt"] == created_time

    # 2. 对同一 (from, to) 边执行在位更新 -> 应返回 False
    updated_edge = RelationEdge(
        from_uri="viking://knowledge/cpu/avx.md",
        to_uri="viking://knowledge/cpu/sse.md",
        predicate="extends",
        label="更新后的扩展说明",
        evidence=["初版证据", "新增的256位支持证据"],
        confidence=0.98,
        createdAt="2026-09-26T12:00:00Z",  # 故意传入不同的 createdAt
        updatedAt="2026-09-26T12:00:00Z",
    )
    is_new_update = graph.add_or_update_edge(updated_edge)
    assert is_new_update is False
    assert graph.edge_count == 1

    # 验证内存与落盘状态：createdAt 必须保持原值，updatedAt 与新字段被更新
    stored_edge = graph._edges[
        ("viking://knowledge/cpu/avx.md", "viking://knowledge/cpu/sse.md")
    ]
    assert stored_edge.label == "更新后的扩展说明"
    assert stored_edge.confidence == 0.98
    assert stored_edge.evidence == ["初版证据", "新增的256位支持证据"]
    assert stored_edge.createdAt == created_time  # 保持原有创建时间！
    assert stored_edge.updatedAt is not None

    # 3. 新增第二条不同目标 URI 的边 -> 应返回 True
    edge2 = RelationEdge(
        from_uri="viking://knowledge/cpu/avx.md",
        to_uri="viking://knowledge/cpu/arm_neon.md",
        predicate="contrasts_with",
        label="架构对比",
    )
    is_new2 = graph.add_or_update_edge(edge2)
    assert is_new2 is True
    assert graph.edge_count == 2


def test_get_neighbors(tmp_path: Path):
    """验证按方向 (out / in / both) 及谓词过滤检索关系边。"""
    jsonl_path = tmp_path / "relations.jsonl"
    graph = RelationGraph(jsonl_path)

    # 拓扑构造：
    # NodeA -> NodeB (extends)
    # NodeA -> NodeC (contrasts_with)
    # NodeD -> NodeA (precedes)
    e1 = RelationEdge(
        from_uri="viking://knowledge/node_a.md",
        to_uri="viking://knowledge/node_b.md",
        predicate="extends",
        label="A extends B",
    )
    e2 = RelationEdge(
        from_uri="viking://knowledge/node_a.md",
        to_uri="viking://knowledge/node_c.md",
        predicate="contrasts_with",
        label="A contrasts with C",
    )
    e3 = RelationEdge(
        from_uri="viking://knowledge/node_d.md",
        to_uri="viking://knowledge/node_a.md",
        predicate="precedes",
        label="D precedes A",
    )

    graph.add_or_update_edge(e1)
    graph.add_or_update_edge(e2)
    graph.add_or_update_edge(e3)

    # 1. 查询 NodeA 的出边 (out)
    out_edges = graph.get_neighbors("viking://knowledge/node_a.md", direction="out")
    assert len(out_edges) == 2
    assert {e.to_uri for e in out_edges} == {
        "viking://knowledge/node_b.md",
        "viking://knowledge/node_c.md",
    }

    # 2. 查询 NodeA 的入边 (in)
    in_edges = graph.get_neighbors("viking://knowledge/node_a.md", direction="in")
    assert len(in_edges) == 1
    assert in_edges[0].from_uri == "viking://knowledge/node_d.md"

    # 3. 查询 NodeA 的双向边 (both)
    both_edges = graph.get_neighbors("viking://knowledge/node_a.md", direction="both")
    assert len(both_edges) == 3

    # 4. 带谓词过滤 (out + extends)
    filtered = graph.get_neighbors(
        "viking://knowledge/node_a.md", direction="out", predicate="extends"
    )
    assert len(filtered) == 1
    assert filtered[0].to_uri == "viking://knowledge/node_b.md"

    # 5. 查询不存在的节点 -> 空列表
    none_edges = graph.get_neighbors(
        "viking://knowledge/non_existent.md", direction="both"
    )
    assert none_edges == []
