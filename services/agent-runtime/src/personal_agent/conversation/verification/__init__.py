"""conversation.verification —— 模型输出校验与反幻觉保障。"""

from personal_agent.conversation.verification.summary import (
    EXTRACT_PDF_CAPABILITY,
    SummaryRejected,
    collect_extracted_pages,
    verify_summary,
)

__all__ = [
    "EXTRACT_PDF_CAPABILITY",
    "SummaryRejected",
    "collect_extracted_pages",
    "verify_summary",
]