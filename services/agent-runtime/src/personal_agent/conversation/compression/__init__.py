"""上下文压缩与知识提炼模块。"""

from personal_agent.conversation.compression.distiller import (
    DISTILL_MODEL_ENV,
    ObservationDistiller,
    build_context_aware_prompt,
    resolve_distill_model,
)
from personal_agent.conversation.compression.document import (
    DOCUMENT_CLOSE_TAG,
    DOCUMENT_OPEN_TAG,
    ProgressDocumentManager,
)
from personal_agent.conversation.compression.invariants import (
    validate_semantic_integrity,
)
from personal_agent.conversation.compression.models import (
    DistilledFact,
    DistilledObservation,
    LifecycleTier,
    ProgressDocumentState,
    TaskType,
)
from personal_agent.conversation.compression.strategy import (
    classify_lifecycle,
    evaluate_window_pressure,
    infer_task_type,
    select_compression_candidates,
)
from personal_agent.conversation.compression.tokens import (
    DEFAULT_TOKEN_ENCODING,
    count_tokens,
)

__all__ = [
    "DEFAULT_TOKEN_ENCODING",
    "DISTILL_MODEL_ENV",
    "DOCUMENT_CLOSE_TAG",
    "DOCUMENT_OPEN_TAG",
    "DistilledFact",
    "DistilledObservation",
    "LifecycleTier",
    "ObservationDistiller",
    "ProgressDocumentManager",
    "ProgressDocumentState",
    "TaskType",
    "build_context_aware_prompt",
    "classify_lifecycle",
    "count_tokens",
    "evaluate_window_pressure",
    "infer_task_type",
    "resolve_distill_model",
    "select_compression_candidates",
    "validate_semantic_integrity",
]
