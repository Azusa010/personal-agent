from typing import Literal

from pydantic import BaseModel, ConfigDict

ExtractionAction = Literal["STORE", "NO_OP"]
MemoryCategory = Literal[
    "user_profile",
    "persona_dynamics",
    "active_goals",
    "coding_standards",
    "project_context",
    "key_decision",
    "other",
]

class CandidateMemoryItem(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    action: ExtractionAction
    category: MemoryCategory | None = None
    content: str | None = None
    confidence: float | None = None
    source_seq_range: tuple[int, int]  # (start_seq_id, end_seq_id)
    extracted_at: str
    status: Literal["pending", "approved", "rejected"] = "pending"

class ExtractionResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    items: list[CandidateMemoryItem]
    processed_events_count: int
    from_seq_id: int | None = None
    to_seq_id: int | None = None
    noop_count: int