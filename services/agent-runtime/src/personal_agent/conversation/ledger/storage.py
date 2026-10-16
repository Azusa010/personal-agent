import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

import tiktoken

from personal_agent.conversation.ledger.guard import LedgerGuard
from personal_agent.conversation.ledger.models import EVENT_TYPE, LedgerEvent


def reverse_read(log_file: Path):
    with open(log_file, "rb") as f:
        f.seek(0, 2)  # Move to the end of the file
        pos = f.tell()
        buf = b""
        while pos > 0:
            size = min(pos, 8192)
            pos -= size
            f.seek(pos)
            buf = f.read(size) + buf
            lines = buf.split(b"\n")
            buf = lines[0]
            for line in reversed(lines[1:]):
                yield line.decode("utf-8")
        if buf:
            yield buf.decode("utf-8")


logger = logging.getLogger(__name__)


def _current_timestamp():
    return int(time.time() * 1000)


class MainEventLedger:
    def __init__(
        self,
        log_file: str | Path,
        guard: LedgerGuard | None = None,
        initial_epoch_id: int = 1,
    ):
        self.log_file = Path(log_file)
        self.guard = guard
        self.initial_epoch_id = initial_epoch_id
        self.latest_seq_id = 0
        self.current_epoch_id: int = initial_epoch_id
        self.lock = threading.Lock()
        self.last_timestamp = 0
        self.sequence = 0
        self.sequence_bits = 12
        self.max_sequence = (1 << self.sequence_bits) - 1  # 4095
        self.enc = tiktoken.get_encoding(os.getenv("TIKTOKEN_ENCODING", "o200k_harmony"))
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        if self.log_file.exists():
            for line in reverse_read(self.log_file):
                if "seq_id" in line:
                    try:
                        seq_id = json.loads(line).get("seq_id", 0)
                        self.latest_seq_id = seq_id
                        break
                    except Exception as e:  # noqa: BLE001
                        logger.warning(
                            f"Failed to parse seq_id from line: {line}. Setting latest_seq_id to 0. Error: {e}"
                        )
                        continue

    def _next_id(self):
        with self.lock:
            timestamp = _current_timestamp()

            if timestamp < self.last_timestamp:
                raise ValueError(
                    f"System clock moved backwards. Refusing to generate id for {self.last_timestamp - timestamp} milliseconds"
                )
            if timestamp == self.last_timestamp:
                self.sequence = (self.sequence + 1) & self.max_sequence
                if self.sequence == 0:
                    while timestamp <= self.last_timestamp:
                        timestamp = _current_timestamp()
            else:
                self.sequence = 0
            self.last_timestamp = timestamp
            self.latest_seq_id += 1
            return self.latest_seq_id

    def append_event(
        self,
        event_type: EVENT_TYPE,
        payload: dict[str, Any] | None = None,
    ) -> LedgerEvent:
        payload.pop("thinking", None)  # Remove 'thinking' key if present
        seq_id = self._next_id()
        event = LedgerEvent(
            seq_id=seq_id,
            epoch_id=self.current_epoch_id,
            timestamp=str(_current_timestamp()),
            event_type=event_type,
            payload=payload,
            token_count=self.enc.encode(json.dumps(payload)).__len__(),
            ephemeral=payload.get("ephemeral", False),
            artifact_path=payload.get("artifact_path", None),
            subagent_run_id=payload.get("subagent_run_id", None),
        )

        with self.lock, open(self.log_file, "a", encoding="utf-8") as f:
            f.write(event.model_dump_json() + "\n")

        return event

    def set_epoch_id(self, epoch_id: int):
        if epoch_id > 0 and epoch_id >= self.current_epoch_id:
            self.current_epoch_id = epoch_id
        else:
            raise ValueError(
                f"Invalid epoch_id: {epoch_id}. It must be greater than 0 and not less than the current epoch_id: {self.current_epoch_id}."
            )

    def read_events(
        self, since_seq_id=0, limit=None, epoch_id=None
    ) -> list[LedgerEvent]:
        events: list[LedgerEvent] = []
        if not self.log_file.exists():
            return events
        with open(self.log_file, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    event = LedgerEvent.model_validate_json(line)
                    if event.seq_id > since_seq_id and (
                        epoch_id is None or event.epoch_id == epoch_id
                    ):
                        events.append(event)
                        if limit is not None and len(events) >= limit:
                            break
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        f"Failed to parse event from line: {line}. Error: {e}"
                    )
                    continue
        return events
