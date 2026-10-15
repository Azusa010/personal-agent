import os

from personal_agent.conversation.ledger import LedgerEvent, MainEventLedger
from personal_agent.conversation.windows.models import (
    ActiveWindowSnapshot,
    WindowConfig,
)


class SlidingWindowLedger:
    def __init__(self, ledger: MainEventLedger, config: WindowConfig | None = None):
        self.ledger = ledger
        self.config = config or WindowConfig(
            epochs_dir=os.path.join(ledger.log_file, "epochs")
        )
        self.window_watermark = 0
        self.rolling_task_summary = ""

    def get_active_window(self) -> ActiveWindowSnapshot:
        events = self.ledger.read_events(self.window_watermark)
        tokens = sum(event.token_count for event in events)
        return ActiveWindowSnapshot(
            events=events,
            total_tokens=tokens,
            window_watermark=self.window_watermark,
            rolling_task_summary=self.rolling_task_summary,
            epoch_id=self.ledger.current_epoch_id,
        )

    def find_safe_compaction_boundary(
        self, events: list[LedgerEvent], target_keep_turns: int
    ) -> int:
        for e in reversed(events):
            if e.event_type == "user":
                target_keep_turns -= 1
                if target_keep_turns <= 0:
                    return e.seq_id - 1
        return 0

    def compact_if_needed(self, summarizer_fn=None) -> bool:
        active_window_token = self.get_active_window().total_tokens
        if (
            active_window_token
            < self.config.max_budget_tokens * self.config.high_watermark_ratio
        ):
            return False

        boundary_seq_id = self.find_safe_compaction_boundary(
            self.ledger.read_events(self.window_watermark),
            self.config.min_preserved_turns,
        )

        if summarizer_fn:
            summary = summarizer_fn(
                [e for e in self.get_active_window().events if e.seq_id <= boundary_seq_id],
                self.rolling_task_summary
            )
        else:
            summary = f"Compacted {boundary_seq_id - self.window_watermark} events."

        self.window_watermark = boundary_seq_id
        self.rolling_task_summary = summary
        return True
