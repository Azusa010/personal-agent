from typing import Any, Literal

from pydantic import BaseModel

EVENT_TYPE = Literal["user", "assistant", "tool_call","tool_result", "system","subagent"]

class LedgerEvent(BaseModel):
    seq_id: int
    epoch_id: int
    timestamp: str
    event_type: EVENT_TYPE
    payload: dict[str, Any]
    token_count: int
    ephemeral: bool = False
    artifact_path: str | None = None
    subagent_run_id: str | None = None
class BlobPointer(BaseModel):
    blob_id: str
    file_path: str
    original_chars: int
    estimated_chars: int
    preview: str