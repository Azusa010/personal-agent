"""Python → stderr 的结构化日志帧发射器。"""

from __future__ import annotations

import json
import sys
from typing import TextIO

from personal_agent.observability.record import (
    PYTHON_LOG_PREFIX,
    LogRecord,
    _default_session_id,
)


class StderrEmitter:
    def __init__(self, stream: TextIO | None = None, session_id: str | None = None) -> None:
        self._stream = stream
        self._session_id = session_id or _default_session_id()

    def emit(self, record: LogRecord) -> None:
        payload = record.to_wire()
        payload["sessionId"] = self._session_id

        try:
            line = PYTHON_LOG_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n"
        except (TypeError, ValueError):
            line = PYTHON_LOG_PREFIX + '{"event":"python.frame.serialize_failed"}\n'

        target = self._stream if self._stream is not None else sys.stderr
        self._write(target, line)

    @staticmethod
    def _write(target: TextIO, line: str) -> None:
        try:
            target.write(line)
            target.flush()
            return
        except UnicodeEncodeError:
            pass
        except (OSError, ValueError):
            return

        try:
            target.write(line.encode("utf-8", "replace").decode("utf-8", "replace"))
            target.flush()
        except (OSError, ValueError):
            return
