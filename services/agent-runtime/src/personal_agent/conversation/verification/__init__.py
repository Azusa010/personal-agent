"""conversation.verification —— 模型输出校验与反幻觉保障。"""

from personal_agent.conversation.verification.summary import (
    EXTRACT_PDF_CAPABILITY,
    RetrievedEvidence,
    SummaryRejected,
    collect_extracted_pages,
    collect_retrieved_evidence,
    verify_summary,
)

__all__ = [
    "EXTRACT_PDF_CAPABILITY",
    "RetrievedEvidence",
    "SummaryRejected",
    "collect_extracted_pages",
    "collect_retrieved_evidence",
    "verify_summary",
]