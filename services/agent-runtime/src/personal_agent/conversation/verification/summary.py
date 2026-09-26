"""

模型不能自己宣布任务完成，摘要必须带有效页码引用、可追溯到
解析后的页面文本。这个模块就是那个「有效」的判定者：
拿这次任务真正提取到的页码当参照集合，逐条 fact 核对。

"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from pydantic import ValidationError

from personal_agent.model_gateway import Observation
from personal_agent.protocol.models import SummaryFact

EXTRACT_PDF_CAPABILITY = "document_extract_pdf"
KNOWLEDGE_SEARCH_CAPABILITY = "knowledge_search"
USER_MEMORY_SEARCH_CAPABILITY = "user_memory_search"
VIKING_READ_CAPABILITIES = frozenset(
    {"viking_read_l0", "viking_read_l1", "viking_read_l2"}
)


@dataclass
class RetrievedEvidence:
    """会话过程中所有成功调用的只读能力所沉淀的真实证据索引集合。"""

    pages: frozenset[int] = field(default_factory=frozenset)
    chunk_ids: frozenset[UUID] = field(default_factory=frozenset)
    memory_ids: frozenset[UUID] = field(default_factory=frozenset)
    viking_uris: frozenset[str] = field(default_factory=frozenset)


def collect_retrieved_evidence(
    observations: Sequence[Observation],
) -> RetrievedEvidence:
    """从会话观测历史中聚合所有经校验的真实证据集合（PDF页码、知识块UUID、记忆UUID、维基URI）。

    # Contract:
    #   - Input: Sequence[Observation] 历史观察
    #   - Output: RetrievedEvidence 包含四类证据的不可变集合
    #   - Invariants: 仅收集 ok=True 的成功工具返回；忽略非法数据结构；防御注入伪造；
    #   - Boundary conditions:
    #       - payload 缺少字段或格式异常时静默跳过，不抛异常（Fail-safe）；
    #       - id 必须为合法 UUID（非合法 UUID 格式忽略）；
    #   - Test file: tests/test_summary.py
    """
    pages = collect_extracted_pages(observations)
    chunk_ids: set[UUID] = set()
    memory_ids: set[UUID] = set()
    viking_uris: set[str] = set()

    for observation in observations:
        if not observation.ok:
            continue
        if observation.capability == KNOWLEDGE_SEARCH_CAPABILITY:
            raw_chunks = observation.payload.get("chunks")
            if isinstance(raw_chunks, list):
                for chunk in raw_chunks:
                    if isinstance(chunk, dict):
                        c_id = chunk.get("id")
                        try:
                            chunk_ids.add(UUID(str(c_id)))
                        except (ValueError, TypeError):
                            continue
        if observation.capability == USER_MEMORY_SEARCH_CAPABILITY:
            raw_items = observation.payload.get("items")
            if isinstance(raw_items, list):
                for item in raw_items:
                    if isinstance(item, dict):
                        item_id = item.get("id") or item.get("card", {}).get("id") or item.get("note", {}).get("id") or item.get("item", {}).get("id")
                        try:
                            memory_ids.add(UUID(str(item_id)))
                        except (ValueError, TypeError):
                            continue
        if observation.capability in VIKING_READ_CAPABILITIES:
            raw_uri = observation.payload.get("uri")
            if isinstance(raw_uri, str) and raw_uri.strip():
                viking_uris.add(raw_uri.strip())
    return RetrievedEvidence(
        pages=pages,
        chunk_ids=frozenset(chunk_ids),
        memory_ids=frozenset(memory_ids),
        viking_uris=frozenset(viking_uris),
    )


class SummaryRejected(Exception):
    """
    模型给的摘要没通过校验，不能算任务完成。
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def collect_extracted_pages(observations: Sequence[Observation]) -> frozenset[int]:
    collected: set[int] = set()
    for observation in observations:
        if observation.capability != EXTRACT_PDF_CAPABILITY or not observation.ok:
            continue
        raw_pages = observation.payload.get("pages")
        if not isinstance(raw_pages, list):
            continue
        for page in raw_pages:
            if not isinstance(page, dict):
                continue
            number = page.get("pageNumber")
            if isinstance(number, bool) or not isinstance(number, int) or number < 1:
                continue
            collected.add(number)
    return frozenset(collected)


def _validation_details(error: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
        for item in error.errors()
    )


def verify_summary(
    facts: Sequence[dict[str, Any]],
    available_pages: frozenset[int],
    *,
    require_page_refs: bool = True,
) -> list[SummaryFact]:
    if not facts:
        if require_page_refs:
            raise SummaryRejected("模型没有给出任何 fact，不构成完成证据")
        return []
    verified: list[SummaryFact] = []
    for index, raw_fact in enumerate(facts,start=1):
        try:
            fact = SummaryFact.model_validate(raw_fact)
        except ValidationError as e:
            raise SummaryRejected(
                f"第 {index} 条 fact 结构不合法: {_validation_details(e)}"
            ) from e
        if require_page_refs and not fact.pageRefs:
            raise SummaryRejected(f"第 {index} 条 fact 没有页码引用，无法追溯到页面")
        missing = [ref for ref in fact.pageRefs if ref not in available_pages]
        if missing:
            raise SummaryRejected(
                f"第 {index} 条 fact 引用了不存在的页码 {missing[0]}"
                f"{_page_scope_clause(available_pages)}"
            )
        verified.append(fact)
    return verified


def _page_scope_clause(available_pages: frozenset[int]) -> str:
    if not available_pages:
        return "（本次任务没有提取到任何 PDF 页面）"
    return f"（本次共提取到 {len(available_pages)} 页）"
