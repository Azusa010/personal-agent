"""OpenViking 知识库自底向上级联维护与拓扑调度器 (Cascader)

实现 OpenViking 规范的自底向上多级级联聚合机制：
1. 目录级联：当叶子 L2 文档变更时，沿着文件系统目录树自底向上收集待更新的目录级联链条
   （由深至浅依次触发各级目录的 .overview.md L1 聚合与 .abstract.md L0 摘要）；
2. 拓扑级联：基于 relations.jsonl 依赖拓扑（如 extends, precedes, implements），
   分析受影响下游节点的传递闭包与更新顺序；
3. 环路防御：通过 DFS 三色染色法严格检测有向图中的闭环回路，阻断级联死循环与无限递归。
"""

import logging
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path, PurePosixPath

logger = logging.getLogger(__name__)


def get_directory_cascade_chain(relative_path: str) -> list[str]:
    """计算指定文档在目录树中自底向上的所有祖先目录（由深到浅）。

    契约要求：
    - 输入例如 "cpu/x86/avx.md"，祖先目录依次为 ["cpu/x86", "cpu", ""]（"" 表示维基根目录）；
    - 输入例如 "guide.md"，祖先目录为 [""]；
    - 输入已位于维基根目录（如 "" 或 "."），返回 [""]；
    - 统一将 Windows 反斜杠规范化为正斜杠。

    :param relative_path: 文档相对于维基根目录的路径
    :returns: 自底向上（由子目录到根目录）的目录相对路径列表
    """
    normalized = PurePosixPath(relative_path.replace("\\", "/"))
    # 取父目录
    parent = normalized.parent
    chain: list[str] = []

    while str(parent) not in (".", ""):
        chain.append(parent.as_posix())
        parent = parent.parent

    # 无论多深，最后都包含根目录 ""
    chain.append("")
    return chain


def detect_cycles(dependency_graph: dict[str, list[str]]) -> list[list[str]]:
    """检测有向依赖图中的所有闭环回路（用于防御级联死循环）。

    契约要求：
    1. 使用 DFS 三色染色法（WHITE=0 未访问，GRAY=1 访问中/递归调用栈中，BLACK=2 已访问完成）；
    2. 当在遍历邻接节点时遇到状态为 GRAY 的节点，说明发现一条反向边，构成回路：
       - 从当前递归路径（栈）中截取出环的完整回路（如 ["A", "B", "C", "A"]）；
       - 记录到环路列表中；
    3. 若无环，返回空列表 `[]`；
    4. 若有环，返回包含各环路节点路径的列表，例如 `[["A", "B", "A"], ["C", "D", "E", "C"]]`。

    :param dependency_graph: 邻接表形式的有向依赖图 (node -> [dependent_nodes])
    :returns: 检测到的所有环路列表（每个环路表示为顺次经过的节点路径）
    """
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {}
    path_stack: list[str] = []
    cycles: list[list[str]] = []

    def dfs(node: str) -> None:
        color[node] = GRAY
        path_stack.append(node)
        for neighbor in dependency_graph.get(node, []):
            neighbor_color = color.get(neighbor, WHITE)
            if neighbor_color == GRAY:
                # 如果邻居节点是灰色的，说明发现了反向边
                if neighbor in path_stack:
                    cycle_start_index = path_stack.index(neighbor)
                    cycle_path = path_stack[cycle_start_index:] + [neighbor]
                    cycles.append(cycle_path)
            elif neighbor_color == WHITE:
                dfs(neighbor)
        path_stack.pop()
        color[node] = BLACK

    # 遍历图中所有节点作为潜在起点
    all_node = set(dependency_graph.keys())
    for targets in dependency_graph.values():
        all_node.update(targets)

    for node in sorted(all_node):
        if color.get(node,WHITE) == WHITE:
            dfs(node)

    return cycles


def compute_cascade_schedule(
    modified_nodes: list[str],
    dependency_graph: dict[str, list[str]],
) -> list[str]:
    """根据初始变更节点集合与依赖图，计算拓扑排序的自底向上级联更新执行队列。

    契约要求：
    1. 计算受影响节点的传递闭包：从 `modified_nodes` 出发，沿 `dependency_graph` 收集所有可达节点；
    2. 环路防御与容错：
       - 调用 `detect_cycles` 检查图谱中是否存在回路；
       - 若存在回路，记录 warning 日志，并在调度中安全打破环（例如忽略导致回溯的环边），避免死循环；
    3. 拓扑排序调度：
       - 保证被依赖节点（前置节点）排在依赖它的节点（后置节点）之前；
       - 例如 A 变更，B 依赖 A，C 依赖 B，则调度序列中 A 先于 B，B 先于 C；
       - 输出按更新顺序列出的唯一节点 ID/URI 列表。

    :param modified_nodes: 初始发生变更的节点列表
    :param dependency_graph: 有向依赖图 (upstream_node -> [downstream_nodes])
    :returns: 拓扑有序的级联更新调度序列
    """
    if not modified_nodes:
        return []

    detected_cycles = detect_cycles(dependency_graph)
    if detected_cycles:
        logger.warning(
            "[viking]Detected %d cycles in dependency graph: %s",
            len(detected_cycles),
            detected_cycles,
        )
    # 收集所有受影响节点的传递闭包
    visited: set[str] = set()
    queue = deque(modified_nodes)
    while queue:
        curr = queue.popleft()
        if curr not in visited:
            visited.add(curr)
            for neighbor in dependency_graph.get(curr, []):
                if neighbor not in visited:
                    queue.append(neighbor)

    # 3. 对受影响子图做拓扑排序
    # 计算入度 (仅考虑受影响子图内的边)
    in_degree: dict[str, int] = {node: 0 for node in visited}
    filtered_graph: dict[str, list[str]] = {node: [] for node in visited}

    for u in visited:
        for v in dependency_graph.get(u, []):
            if v in visited:
                filtered_graph[u].append(v)
                in_degree[v] += 1

    sched_queue = deque([node for node in visited if in_degree[node] == 0])
    schedule: list[str] = []

    while sched_queue:
        node = sched_queue.popleft()
        schedule.append(node)
        for neighbor in filtered_graph[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                sched_queue.append(neighbor)

    for node in visited:
        if node not in schedule:
            schedule.append(node)

    return schedule


class BottomUpCascader:
    """自底向上级联维护管理器。整合目录树层级与图谱拓扑依赖。"""

    def __init__(
        self,
        wiki_root: Path,
        dependency_graph: dict[str, list[str]] | None = None,
    ):
        self.wiki_root = wiki_root
        self.dependency_graph = dependency_graph or {}

    def plan_file_change_cascade(self, changed_relative_file: str) -> list[str]:
        """为一个具体叶子文档的变更规划全套级联更新目标（包含目录祖先与拓扑下游）。"""
        # 1. 目录树链条（物理结构级联：自身所在的每一级父目录）
        dir_chain = get_directory_cascade_chain(changed_relative_file)
        dir_targets = [f"dir://{d}" if d else "dir://" for d in dir_chain]

        # 2. 拓扑下游链条（语义图谱级联）
        doc_uri = f"viking://{changed_relative_file}"
        topo_schedule = compute_cascade_schedule([doc_uri], self.dependency_graph)

        # 3. 组合并去重，保持物理目录底向顶在先、拓扑在后的稳定顺序
        combined: list[str] = []
        for t in dir_targets:
            if t not in combined:
                combined.append(t)
        for t in topo_schedule:
            if t not in combined and t != doc_uri:
                combined.append(t)

        return combined

    async def execute_cascade(
        self,
        schedule: list[str],
        update_handler: Callable[[str], Awaitable[None]],
    ) -> int:
        """顺次执行级联更新任务。"""
        count = 0
        for target in schedule:
            try:
                await update_handler(target)
                count += 1
            except Exception as err:  # noqa: BLE001
                logger.error("Cascade update failed for %s: %s", target, err)
        return count
