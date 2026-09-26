"""OpenViking 知识图谱关系边引擎 (RelationGraph)

以 relations.jsonl 格式持久化管理文档节点间的有向关系边，
提供在位去重更新、双向邻接拓扑查询与序列化能力。
"""

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# OpenViking 官方支持的核心拓扑谓词
VALID_PREDICATES = {
    "extends",  # 演进/扩展 (如 AVX extends SSE)
    "extended_by",  # 被扩展 (反向)
    "precedes",  # 前置/依赖 (如 C语言 precedes C++)
    "succeeded_by",  # 后续/演进自 (反向)
    "contrasts_with",  # 方案对比 (如 RISC-V contrasts_with x86)
    "supersedes",  # 替代/废弃 (如 OAuth 2.1 supersedes OAuth 2.0)
    "superseded_by",  # 被替代 (反向)
    "implements",  # 实现规范 (如 Linux implements POSIX)
    "implemented_by",  # 被实现 (反向)
    "related_to",  # 通用强相关
}


class RelationEdge(BaseModel):
    """知识图谱中的单条有向关系边，严格对齐 OpenViking relations.jsonl 契约。"""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    from_uri: str = Field(alias="from", min_length=1)
    to_uri: str = Field(alias="to", min_length=1)
    predicate: str = Field(min_length=1)
    label: str = Field(default="")
    evidence: list[str] = Field(default_factory=list)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    createdAt: str | None = None
    updatedAt: str | None = None


def now_utc_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class RelationGraph:
    """管理 relations.jsonl 的图谱持久化与内存索引。"""

    def __init__(self, jsonl_path: Path):
        self.jsonl_path = jsonl_path
        self._edges: dict[tuple[str, str], RelationEdge] = {}
        self._outgoing: dict[str, set[str]] = {}
        self._incoming: dict[str, set[str]] = {}
        self.load()

    def load(self) -> None:
        """从 relations.jsonl 加载全部边到内存索引。文件不存在时自动初始化。"""
        self._edges.clear()
        self._outgoing.clear()
        self._incoming.clear()

        if not self.jsonl_path.exists():
            self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
            self.jsonl_path.touch()
            return

        with self.jsonl_path.open("r", encoding="utf-8") as f:
            for line in f:
                line_str = line.strip()
                if not line_str:
                    continue
                try:
                    data = json.loads(line_str)
                    edge = RelationEdge.model_validate(data)
                    key = (edge.from_uri, edge.to_uri)
                    self._edges[key] = edge

                    self._outgoing.setdefault(edge.from_uri, set()).add(edge.to_uri)
                    self._incoming.setdefault(edge.to_uri, set()).add(edge.from_uri)
                except (json.JSONDecodeError, ValueError) as err:
                    # 容错跳过单行损坏
                    logger.warning("Skipping corrupted relation line: %s", err)
                    continue

    def save(self) -> None:
        """将内存中的全部边原子写入 relations.jsonl。"""
        self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.jsonl_path.with_suffix(".jsonl.tmp")
        with temp_path.open("w", encoding="utf-8") as f:
            for edge in self._edges.values():
                line = json.dumps(
                    edge.model_dump(by_alias=True, exclude_none=True),
                    ensure_ascii=False,
                )
                f.write(line + "\n")
        temp_path.replace(self.jsonl_path)

    @property
    def edge_count(self) -> int:
        return len(self._edges)

    def add_or_update_edge(self, edge: RelationEdge) -> bool:
        """在图谱中新增或在位更新一条关系边。
        :param edge: 待存入的 RelationEdge 对象
        :returns: 新增返回 True，在位更新返回 False
        """
        key = (edge.from_uri, edge.to_uri)
        if key in self._edges:
            old_edge = self._edges[key]
            edge.createdAt = old_edge.createdAt
            edge.updatedAt = now_utc_iso()
            self._edges[key] = edge
            self.save()
            return False
        now = now_utc_iso()
        if not edge.createdAt:
            edge.createdAt = now
        if not edge.updatedAt:
            edge.updatedAt = now
        self._edges[key] = edge
        self._outgoing.setdefault(edge.from_uri, set()).add(edge.to_uri)
        self._incoming.setdefault(edge.to_uri, set()).add(edge.from_uri)
        self.save()
        return True

    def get_neighbors(
        self,
        uri: str,
        direction: Literal["out", "in", "both"] = "both",
        predicate: str | None = None,
    ) -> list[RelationEdge]:
        """查询与指定 URI 关联的边。

        :param uri: 目标节点 URI
        :param direction: 检索方向 ("out" | "in" | "both")
        :param predicate: 可选谓词过滤
        :returns: 符合条件的边列表
        """
        result = []
        if direction in ("out", "both"):
            for to_uri in self._outgoing.get(uri, set()):
                edge = self._edges[(uri, to_uri)]
                if predicate is None or edge.predicate == predicate:
                    result.append(edge)
        if direction in ("in", "both"):
            for from_uri in self._incoming.get(uri, set()):
                edge = self._edges[(from_uri, uri)]
                if predicate is None or edge.predicate == predicate:
                    result.append(edge)
        return result
