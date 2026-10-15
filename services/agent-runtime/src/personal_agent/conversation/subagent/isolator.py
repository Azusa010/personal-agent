import threading
import time
from pathlib import Path
from typing import Any

from personal_agent.conversation.subagent.models import SubagentTraceEvent


def _current_timestamp():
    return int(time.time() * 1000)


class TraceIsolator:
    def __init__(self, run_id: str, trace_file: str | Path):
        self.run_id = run_id
        self.trace_file = Path(trace_file)
        self.lock = threading.Lock()
        self.trace_file.parent.mkdir(parents=True, exist_ok=True)
        self.step_id = 0
        self.last_timestamp = 0
        self.sequence = 0
        self.sequence_bits = 12
        self.max_sequence = (1 << self.sequence_bits) - 1  # 409

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
            self.step_id += 1
            return self.step_id

    def append_event(
        self, event_type: str, payload: dict[str, Any]
    ) -> SubagentTraceEvent:
        step_id = self._next_id()
        event = SubagentTraceEvent(
            step_id=step_id,
            timestamp=str(_current_timestamp()),
            event_type=event_type,
            payload=payload,
        )
        with self.lock, open(self.trace_file, "a", encoding="utf-8") as f:
            f.write(event.model_dump_json() + "\n")
        return event

    def record_thought(self, thought: str):
        return self.append_event("thought", {"thought": thought})

    def record_tool_call(self, call_id: str, tool_name: str, arguments: dict[str, Any]):
        return self.append_event(
            "tool_call",
            {"call_id": call_id, "tool_name": tool_name, "arguments": arguments},
        )

    def record_tool_result(
        self, call_id: str, tool_name: str, result: Any, ok: bool = True
    ):
        return self.append_event(
            "tool_result",
            {"call_id": call_id, "ok": ok, "tool_name": tool_name, "result": result},
        )

    def record_error(self, error_message: str, error_type: str | None = None):
        return self.append_event(
            "error", {"error_message": error_message, "error_type": error_type}
        )

    def read_trace(self, event_type: str | None = None) -> list[SubagentTraceEvent]:
        events = []
        with self.lock, open(self.trace_file, "r", encoding="utf-8") as f:
            for line in f:
                event = SubagentTraceEvent.model_validate_json(line)
                if event_type is None or event.event_type == event_type:
                    events.append(event)
        return events

    def get_total_steps(self) -> int:
        return self.step_id
