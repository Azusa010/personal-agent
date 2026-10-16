import uuid
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ExtractionAction = Literal["STORE", "NO_OP", "APPEND"] | str
MemoryCategory = str


class CandidateMemoryItem(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(default_factory=lambda: f"mem-{uuid.uuid4().hex[:12]}")
    action: ExtractionAction = "APPEND"
    category: MemoryCategory | None = None
    content: str | None = None
    confidence: float | None = None
    source_seq_range: tuple[int, int] = (0, 0)  # (start_seq_id, end_seq_id)
    extracted_at: str = Field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )
    status: Literal["pending", "approved", "rejected"] = "pending"

class ExtractionResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    items: list[CandidateMemoryItem]
    processed_events_count: int
    from_seq_id: int | None = None
    to_seq_id: int | None = None
    noop_count: int