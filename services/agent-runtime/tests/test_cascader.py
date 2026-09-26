"""OpenViking 自底向上级联维护与环路检测 (Cascader) 单元测试。"""

from pathlib import Path

import pytest

from personal_agent.knowledge.cascader import (
    BottomUpCascader,
    compute_cascade_schedule,
    detect_cycles,
    get_directory_cascade_chain,
)


def test_get_directory_cascade_chain():
    """验证多级文件路径自底向上的目录祖先收集，统一正斜杠与根目录。"""
    # 1. 三级子目录中的文件
    chain1 = get_directory_cascade_chain("cpu/x86/avx.md")
    assert chain1 == ["cpu/x86", "cpu", ""]

    # 2. 根目录下的直接文件
    chain2 = get_directory_cascade_chain("README.md")
    assert chain2 == [""]

    # 3. Windows 反斜杠格式
    chain3 = get_directory_cascade_chain("systems\\os\\process.md")
    assert chain3 == ["systems/os", "systems", ""]

    # 4. 二级子目录
    chain4 = get_directory_cascade_chain("math/linear_algebra.md")
    assert chain4 == ["math", ""]


def test_detect_cycles_no_cycle():
    """验证无环 DAG 图能够被正确判定，返回空列表。"""
    # DAG: A -> B, B -> C, A -> C
    dag = {
        "A": ["B", "C"],
        "B": ["C"],
        "C": [],
    }
    cycles = detect_cycles(dag)
    assert cycles == []


def test_detect_cycles_with_cycles():
    """验证简单环、多节点环与自环均能被准确检测并提取回路路径。"""
    # 1. 简单三节点闭环: A -> B -> C -> A
    cyclic_graph1 = {
        "A": ["B"],
        "B": ["C"],
        "C": ["A"],
    }
    cycles1 = detect_cycles(cyclic_graph1)
    assert len(cycles1) >= 1
    # 环路起点与终点应为同一节点
    first_cycle = cycles1[0]
    assert first_cycle[0] == first_cycle[-1]
    assert set(first_cycle) == {"A", "B", "C"}

    # 2. 自环: X -> X
    self_loop_graph = {
        "X": ["X"],
    }
    cycles2 = detect_cycles(self_loop_graph)
    assert len(cycles2) >= 1
    assert cycles2[0] == ["X", "X"]

    # 3. 混合图：部分分支有环，部分分支无环
    mixed_graph = {
        "P": ["Q"],
        "Q": ["P"],  # P <-> Q 构成环
        "M": ["N"],  # M -> N 无环
        "N": [],
    }
    cycles3 = detect_cycles(mixed_graph)
    assert len(cycles3) >= 1
    cycle_nodes = {node for cyc in cycles3 for node in cyc}
    assert "P" in cycle_nodes and "Q" in cycle_nodes
    assert "M" not in cycle_nodes and "N" not in cycle_nodes


def test_compute_cascade_schedule_linear_and_branching():
    """验证自底向上拓扑调度：保证依赖前置节点先于后置节点更新。"""
    # 拓扑结构：
    # A 变更
    # A -> B
    # A -> C
    # B -> D
    # C -> D
    dep_graph = {
        "A": ["B", "C"],
        "B": ["D"],
        "C": ["D"],
        "D": [],
    }

    schedule = compute_cascade_schedule(["A"], dep_graph)

    # 1. 包含全部 4 个可达节点且无重复
    assert set(schedule) == {"A", "B", "C", "D"}
    assert len(schedule) == 4

    # 2. 顺序约束校验：A 必须先于 B 和 C；B 和 C 必须先于 D
    idx_a = schedule.index("A")
    idx_b = schedule.index("B")
    idx_c = schedule.index("C")
    idx_d = schedule.index("D")

    assert idx_a < idx_b
    assert idx_a < idx_c
    assert idx_b < idx_d
    assert idx_c < idx_d


def test_compute_cascade_schedule_with_cycle_tolerance():
    """验证含环依赖图下的容错调度：不抛异常、不死循环，安全输出调度序列。"""
    # 含环图：A -> B -> C -> B (B 与 C 互为环)
    cyclic_dep = {
        "A": ["B"],
        "B": ["C"],
        "C": ["B"],
    }

    schedule = compute_cascade_schedule(["A"], cyclic_dep)

    # 验证不陷入死循环，包含受影响的所有节点
    assert "A" in schedule
    assert "B" in schedule
    assert "C" in schedule
    # 元素去重
    assert len(schedule) == len(set(schedule))
    # A 仍然是最早的触发源
    assert schedule[0] == "A"


@pytest.mark.asyncio
async def test_bottom_up_cascader_integration(tmp_path: Path):
    """验证 BottomUpCascader 物理目录祖先与语义拓扑级联的整合与执行。"""
    wiki_root = tmp_path / "wiki"
    wiki_root.mkdir()

    # 语义依赖：avx 变更会影响 matrix
    dep_graph = {
        "viking://cpu/x86/avx.md": ["viking://math/matrix.md"],
    }

    cascader = BottomUpCascader(wiki_root, dep_graph)
    plan = cascader.plan_file_change_cascade("cpu/x86/avx.md")

    # 1. 物理目录应按由深至浅排在前面
    assert "dir://cpu/x86" in plan
    assert "dir://cpu" in plan
    assert "dir://" in plan
    idx_leaf_dir = plan.index("dir://cpu/x86")
    idx_root_dir = plan.index("dir://")
    assert idx_leaf_dir < idx_root_dir

    # 2. 拓扑下游也应包含在调度规划中
    assert "viking://math/matrix.md" in plan

    # 3. 模拟异步执行级联更新
    executed: list[str] = []

    async def mock_handler(target: str) -> None:
        executed.append(target)

    count = await cascader.execute_cascade(plan, mock_handler)
    assert count == len(plan)
    assert executed == plan
