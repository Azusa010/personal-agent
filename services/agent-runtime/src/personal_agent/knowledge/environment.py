"""
知识库系统共享环境抽象 (Knowledge Environment)。

为 Proposer 与 Reviewer 两个独立 Agent 提供完整的底层数据源访问支撑：
- 完整原始证据库 (Evidence Store)：存储原始文本材料、PDF 切页与会话上下文，支持精准按 ID 溯源与语义检索；
- 完整知识库 (Knowledge Store)：存储法条、规则与文档切块 (chunks)，支持多文档版本比对与检索；
- 完整用户记忆库 (Memory Store)：存储用户历史偏好、习惯与既往事实。
"""

import difflib
from typing import Any
from uuid import UUID


class KnowledgeEnvironment:
    """提供给智能体自由查询完整知识库与证据库的环境接口。"""

    def __init__(
        self,
        evidence_store: dict[UUID, str] | None = None,
        knowledge_store: list[dict[str, Any]] | None = None,
        memory_store: list[dict[str, Any]] | None = None,
    ) -> None:
        self.evidence_store: dict[UUID, str] = evidence_store or {}
        self.knowledge_store: list[dict[str, Any]] = knowledge_store or []
        self.memory_store: list[dict[str, Any]] = memory_store or []

    def register_evidence(self, evidence_id: UUID, content: str) -> None:
        """向原始证据库注入/注册一条真实证据。"""
        self.evidence_store[evidence_id] = content

    def get_evidence(self, evidence_id: UUID | str) -> dict[str, Any] | None:
        """追溯原始证据库，获取未被篡改的完整证据原文。"""
        try:
            uid = UUID(str(evidence_id))
        except (ValueError, TypeError):
            return None
        if uid in self.evidence_store:
            return {"id": str(uid), "content": self.evidence_store[uid]}
        return None

    def search_evidence(
        self, query: str, limit: int = 5, fallback_on_empty: bool = False
    ) -> list[dict[str, Any]]:
        """在原始证据库中按关键词检索相关的原始证据。"""
        terms = [t.lower() for t in query.split() if t.strip()]
        matched: list[dict[str, Any]] = []
        for uid, text in self.evidence_store.items():
            text_lower = text.lower()
            if any(t in text_lower for t in terms):
                matched.append({"id": str(uid), "content": text})
            if len(matched) >= limit:
                break
        if not matched and fallback_on_empty and self.evidence_store:
            for uid, text in list(self.evidence_store.items())[:limit]:
                matched.append({"id": str(uid), "content": text})
        return matched

    def search_knowledge(
        self,
        query: str,
        target_layer: str = "document_chunk",
        limit: int = 5,
        fallback_on_empty: bool = False,
    ) -> list[dict[str, Any]]:
        """在知识库（文档切块/法条）中检索相关条目，用于查重与多文档对比。"""
        terms = [t.lower() for t in query.split() if t.strip()]
        matched: list[dict[str, Any]] = []
        for item in self.knowledge_store:
            text = str(item.get("text", "")).lower()
            if any(t in text for t in terms):
                matched.append(item)
            if len(matched) >= limit:
                break
        if not matched and fallback_on_empty and self.knowledge_store:
            matched = list(self.knowledge_store[:limit])
        return matched

    def get_knowledge_item(
        self, target_layer: str, item_id: UUID | str
    ) -> dict[str, Any] | None:
        """根据 ID 精确获取某条知识项。"""
        id_str = str(item_id)
        for item in self.knowledge_store:
            if str(item.get("id")) == id_str:
                return item
        return None

    def search_user_memory(
        self, query: str, limit: int = 5, fallback_on_empty: bool = False
    ) -> list[dict[str, Any]]:
        """在长期用户记忆库中检索用户偏好、身份与历史约定。"""
        terms = [t.lower() for t in query.split() if t.strip()]
        matched: list[dict[str, Any]] = []
        for item in self.memory_store:
            text = (
                str(item.get("content", ""))
                + " "
                + str(item.get("subject", ""))
                + " "
                + str(item.get("title", ""))
            ).lower()
            if any(t in text for t in terms):
                matched.append(item)
            if len(matched) >= limit:
                break
        if not matched and fallback_on_empty and self.memory_store:
            matched = list(self.memory_store[:limit])
        return matched

    @staticmethod
    def compare_versions(old_text: str, new_text: str) -> dict[str, Any]:
        """比对两个版本的文本差异，分析修改幅度与潜在语义漂移。"""
        matcher = difflib.SequenceMatcher(None, old_text, new_text)
        ratio = matcher.ratio()
        diff = list(
            difflib.unified_diff(
                old_text.splitlines(),
                new_text.splitlines(),
                fromfile="existing_version",
                tofile="proposed_version",
                lineterm="",
            )
        )
        return {
            "similarity_ratio": round(ratio, 4),
            "diff_lines": diff,
            "has_significant_change": ratio < 0.8,
        }
