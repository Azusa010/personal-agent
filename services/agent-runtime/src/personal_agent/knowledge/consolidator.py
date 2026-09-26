"""
周期性全量知识整理器 (Knowledge Consolidator)。

模拟人类睡眠过程中的大脑记忆巩固机制（基于《深入理解 AI Agent》第 3 章 3.5 节）。
职责包括：
1. 知识去重与冗余合并；
2. 回溯原始证据层校验（防止多代提炼中的“传话游戏”失真退化）；
3. 冲突事实调解与场景限定转写 (Qualification Transformation)；
4. 失效或无凭据事实的安全下线隔离。
"""

import logging
from typing import Any
from uuid import UUID

from personal_agent.knowledge.agentic_search import calculate_jaccard_similarity

logger = logging.getLogger(__name__)


class KnowledgeConsolidator:
    """全量知识与记忆后台整理器。"""

    def deduplicate_entries(
        self,
        entries: list[dict[str, Any]],
        similarity_threshold: float = 0.85,
    ) -> list[dict[str, Any]]:
        """基于相似度对知识条目进行合并去重，合并其证据引用集合。"""
        if not entries:
            return []

        deduped: list[dict[str, Any]] = []

        for item in entries:
            text = item.get("text", "").strip()
            if not text:
                continue

            # 寻找现有列表中是否存在高度重合的条目
            merged = False
            for existing in deduped:
                ex_text = existing.get("text", "").strip()
                if (
                    calculate_jaccard_similarity(text, ex_text)
                    >= similarity_threshold
                ):
                    # 合并证据引用
                    ex_refs = set(existing.get("evidenceRefs", []))
                    new_refs = set(item.get("evidenceRefs", []))
                    existing["evidenceRefs"] = list(ex_refs | new_refs)

                    # 若新条目文本更长/信息更丰富，更新正文
                    if len(text) > len(ex_text):
                        existing["text"] = text

                    merged = True
                    break

            if not merged:
                # 浅拷贝保留原字段
                deduped.append(dict(item))

        return deduped

    def retrace_and_verify_evidence(
        self,
        entries: list[dict[str, Any]],
        valid_evidence_ids: set[UUID],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """回溯原始只读证据层：隔离证据已失效或凭空捏造的条目（防传话游戏退化）。

        返回：(保留的有效条目列表, 退化被下线的条目列表)
        """
        retained: list[dict[str, Any]] = []
        degraded: list[dict[str, Any]] = []

        for item in entries:
            raw_refs = item.get("evidenceRefs", [])
            item_refs: set[UUID] = set()
            for r in raw_refs:
                try:
                    item_refs.add(UUID(str(r)))
                except (ValueError, TypeError):
                    continue

            # 若没有任何有效证据挂钩，或者引用的证据无一在有效集合中，判定为退化条目
            if not item_refs or not item_refs.intersection(valid_evidence_ids):
                degraded.append(item)
                logger.warning(
                    "知识条目回溯原始证据失败，标记下线隔离: id=%s text=%s",
                    item.get("id"),
                    item.get("text", "")[:30],
                )
            else:
                retained.append(item)

        return retained, degraded

    def resolve_conflicts_with_qualification(
        self,
        entries: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """将相互冲突的知识转写为带有场景适用限定 (qualification) 的并存条目。"""
        resolved: list[dict[str, Any]] = []
        for item in entries:
            item_copy = dict(item)
            if item.get("is_conflict") and not item.get("qualification"):
                # 自动赋予待定场景限定，避免直接抹杀先前结论
                item_copy["qualification"] = (
                    "待进一步核实的前提案情或特定抗辩事由"
                )
            resolved.append(item_copy)
        return resolved
