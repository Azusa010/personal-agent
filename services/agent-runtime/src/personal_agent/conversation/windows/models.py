from pathlib import Path

from pydantic import BaseModel

from personal_agent.conversation.ledger import LedgerEvent


class WindowConfig(BaseModel):
    max_budget_tokens: int = 100_000
    high_watermark_ratio: float = 0.7
    min_preserved_turns: int = 6
    inactivity_threshold_seconds: int = 5 * 3600
    epochs_dir: Path | str = Path('./epochs')


class ActiveWindowSnapshot(BaseModel):
    window_watermark: int
    rolling_task_summary: str
    events: list[LedgerEvent]
    total_tokens: int
    epoch_id: int


class EpochArchive(BaseModel):
    epoch_id: int
    archived_at: str
    file_path: Path | str = Path('./epochs')
    summary: str
    events_count: int
    time_elapsed_seconds: float
