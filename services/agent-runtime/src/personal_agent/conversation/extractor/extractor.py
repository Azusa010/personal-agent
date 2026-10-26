import threading
from collections.abc import Callable

from personal_agent.conversation.extractor.cursor import ExtractorCursor
from personal_agent.conversation.extractor.filter import is_noise_event
from personal_agent.conversation.extractor.inbox import MemoryInbox
from personal_agent.conversation.extractor.models import (
    CandidateMemoryItem,
    ExtractionResult,
)
from personal_agent.conversation.ledger import LedgerEvent, MainEventLedger


class ColdMemoryExtractor:
    def __init__(
        self,
        ledger: MainEventLedger,
        inbox: MemoryInbox,
        cursor: ExtractorCursor,
        extract_fn: Callable[
            [list[LedgerEvent]], ExtractionResult | list[CandidateMemoryItem]
        ]
        | None = None,
        batch_size: int = 10,
        min_confidence: float = 0.7,
    ):
        self.ledger = ledger
        self.inbox = inbox
        self.cursor = cursor
        self.extract_fn = extract_fn
        self.batch_size = batch_size
        self.min_confidence = min_confidence
        self.lock = threading.Lock()

    def extract_next_batch(self) -> ExtractionResult:
        with self.lock:
            events = self.ledger.read_events(
                self.cursor.last_extracted_seq_id, self.batch_size
            )
            if not events:
                return ExtractionResult(
                    items=[],
                    processed_events_count=0,
                    noop_count=0,
                )

            filtered_events = [
                e
                for e in events
                if not is_noise_event(e) and e.event_type in ["user", "assistant"]
            ]
            if len(filtered_events) == 0:
                self.cursor.advance(events[-1].seq_id)
                return ExtractionResult(
                    # items 是必填字段：整批都是噪音也要显式给空列表，
                    # 否则 Pydantic 校验直接抛错，把整条记忆流水线打断。
                    items=[],
                    processed_events_count=len(events),
                    from_seq_id=events[0].seq_id,
                    to_seq_id=events[-1].seq_id,
                    noop_count=len(events),
                )

            summary = self.extract_fn(filtered_events) if self.extract_fn else None
            filtered_summary: list[CandidateMemoryItem] = []
            if isinstance(summary, ExtractionResult):
                filtered_summary = (
                    [
                        s
                        for s in summary.items
                        if s.confidence >= self.min_confidence and s.action != "NO_OP"
                    ]
                    if summary.items
                    else []
                )
            elif isinstance(summary, list):
                filtered_summary = (
                    [
                        s
                        for s in summary
                        if s.confidence >= self.min_confidence and s.action != "NO_OP"
                    ]
                    if summary
                    else []
                )
            self.inbox.append_batch(filtered_summary)
            self.cursor.advance(events[-1].seq_id)
            return ExtractionResult(
                items=filtered_summary,
                processed_events_count=len(events),
                from_seq_id=events[0].seq_id,
                to_seq_id=events[-1].seq_id,
                noop_count=len(events) - len(filtered_summary),
            )

    def drain_all(self, max_batches: int = 50) -> list[ExtractionResult]:
        result: list[ExtractionResult] = []
        while True:
            batch_result = self.extract_next_batch()
            if batch_result.processed_events_count == 0 or len(result) >= max_batches:
                break
            result.append(batch_result)
        return result
