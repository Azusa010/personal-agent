"""

模型不能自己宣布任务完成，摘要必须带有效页码引用、可追溯到
解析后的页面文本。这个模块就是那个「有效」的判定者：
拿这次任务真正提取到的页码当参照集合，逐条 fact 核对。

"""

from collections.abc import Sequence
from typing import Any

from pydantic import ValidationError

from personal_agent.model_gateway import Observation
from personal_agent.protocol.models import SummaryFact

EXTRACT_PDF_CAPABILITY = "document.extract_pdf"


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
    facts: Sequence[dict[str, Any]], available_pages: frozenset[int]
) -> list[SummaryFact]:
    if not facts:
        raise SummaryRejected("模型没有给出任何 fact，不构成完成证据")

    verified: list[SummaryFact] = []
    for index, raw_fact in enumerate(facts, start=1):
        try:
            fact = SummaryFact.model_validate(raw_fact)
        except ValidationError as e:
            raise SummaryRejected(
                f"第 {index} 条 fact 结构不合法: {_validation_details(e)}"
            ) from e
        if not fact.pageRefs:
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
