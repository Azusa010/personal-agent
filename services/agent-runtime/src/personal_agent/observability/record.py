"""日志记录构造、脱敏与指纹（与 TS 侧共享 fixture）。"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import traceback
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TextIO

PYTHON_LOG_PREFIX = "@@PALOG@@"
SCHEMA_VERSION = 1
LOG_LEVELS = ("debug", "info", "warn", "error", "fatal")
LOG_SOURCES = ("main", "python", "renderer")

MESSAGE_CHARS = 4096
STACK_CHARS = 8192
CONTEXT_STRING_CHARS = 512
CONTEXT_DEPTH = 4
CONTEXT_ARRAY_ITEMS = 50
NORMALIZED_MESSAGE_CHARS = 200
TOP_FRAME_CHARS = 120
ELLIPSIS = "…"

_SENSITIVE_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "token",
        "password",
        "passwd",
        "secret",
        "authorization",
        "credential",
        "credentials",
    }
)

_LEVEL_BY_NAME = {
    "DEBUG": "debug",
    "INFO": "info",
    "WARNING": "warn",
    "WARN": "warn",
    "ERROR": "error",
    "CRITICAL": "fatal",
    "FATAL": "fatal",
}

_REDACTION_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"""((?:api_key|access_token|refresh_token|token|password|passwd|secret|authorization)[ \t]*[:=][ \t]*)(?:(?:Bearer|Basic|Token)[ \t]+)?(?:"[^"]*"|'[^']*'|[^\s,;)}\]])+""",
            re.IGNORECASE,
        ),
        r"\1***",
    ),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer ***"),
    (re.compile(r"(sk|pk)-[A-Za-z0-9_-]{16,}"), r"\1-***"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<email>"),
    (re.compile(r"\b1[3-9][0-9]{9}\b"), "<phone>"),
    (re.compile(r"([A-Za-z]:\\Users\\)[^\\\s\x22\x27]+"), r"\1<user>"),
    (re.compile(r"(/home/|/Users/)[^/\s\x22\x27]+"), r"\1<user>"),
)

_UUID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z?")
_HEX = re.compile(r"0x[0-9a-fA-F]+")
_NUMBER = re.compile(r"[0-9]+(\.[0-9]+)?")
_SPACE = re.compile(r"\s+")
_FRAME = re.compile(r"^\s*at\s+(.+)$")
_NAMED_FRAME = re.compile(r"^(.+?)\s*\((.+)\)$")
_LOCATION_SUFFIX = re.compile(r":[0-9]+(?::[0-9]+)?$")
_PATH_SEPARATOR = re.compile(r"[\\/]")


def _truncate(text: str, limit: int) -> str:
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    return text[: limit - 1] + ELLIPSIS


def _collapse(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def redact_text(text: str) -> str:
    output = text
    for pattern, replacement in _REDACTION_RULES:
        output = pattern.sub(replacement, output)
    return output


def normalize_message(message: str) -> str:
    output = _UUID.sub("<uuid>", message.strip())
    output = _TIMESTAMP.sub("<ts>", output)
    output = _HEX.sub("<hex>", output)
    output = _NUMBER.sub("<n>", output)
    output = _collapse(output)
    return output[:NORMALIZED_MESSAGE_CHARS]


def _basename_of(target: str) -> str:
    without_location = _LOCATION_SUFFIX.sub("", target.strip())
    if not without_location:
        return ""
    return _PATH_SEPARATOR.split(without_location)[-1]


def _format_frame(raw: str) -> str:
    named = _NAMED_FRAME.match(raw)
    if named is not None:
        name = _collapse(named.group(1))
        base = _basename_of(named.group(2))
        if name and base:
            return f"{name}@{base}"
    base = _basename_of(raw)
    if base:
        return f"@{base}"
    return _collapse(raw)[:TOP_FRAME_CHARS]


def top_frame(stack: str | None) -> str | None:
    if not stack:
        return None
    for line in stack.split("\n"):
        matched = _FRAME.match(line)
        if matched is None:
            continue
        body = matched.group(1).strip()
        if not body:
            continue
        return _format_frame(body)
    return None


def compute_fingerprint(
    *,
    source: str,
    event: str,
    code: str | None = None,
    message: str = "",
    stack: str | None = None,
) -> str:
    payload = "|".join(
        [
            source,
            event,
            code or "-",
            normalize_message(message or ""),
            top_frame(stack) or "-",
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def python_level_to_log_level(level: int | str) -> str:
    if isinstance(level, str):
        return _LEVEL_BY_NAME.get(level.strip().upper(), "info")
    if level >= logging.CRITICAL:
        return "fatal"
    if level >= logging.ERROR:
        return "error"
    if level >= logging.WARNING:
        return "warn"
    if level >= logging.INFO:
        return "info"
    return "debug"


def _sanitize_value(value: Any, depth: int, seen: set[int]) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return _truncate(redact_text(value), CONTEXT_STRING_CHARS)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, BaseException):
        return {
            "name": _truncate(redact_text(type(value).__name__), CONTEXT_STRING_CHARS),
            "message": _truncate(redact_text(str(value)), CONTEXT_STRING_CHARS),
            "stack": _truncate(
                redact_text("".join(traceback.format_exception(type(value), value, value.__traceback__))),
                STACK_CHARS,
            ),
        }
    if isinstance(value, (bytes, bytearray)):
        return "<unsupported>"
    if not isinstance(value, (dict, list, tuple, set, frozenset)):
        return "<unsupported>"

    marker = id(value)
    if marker in seen:
        return "<circular>"
    if depth + 1 > CONTEXT_DEPTH:
        return "<depth-limit>"
    seen.add(marker)

    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for raw_key, child in value.items():
            key = str(raw_key)
            if child is None:
                output[key] = None
                continue
            if key.strip().lower() in _SENSITIVE_KEYS:
                output[key] = "***"
                continue
            output[key] = _sanitize_value(child, depth + 1, seen)
        return output

    items = list(value)
    return [_sanitize_value(item, depth + 1, seen) for item in items[:CONTEXT_ARRAY_ITEMS]]


def sanitize_context(context: dict[str, Any] | None) -> dict[str, Any] | None:
    if context is None:
        return None
    result = _sanitize_value(context, 0, set())
    if not isinstance(result, dict):
        return None
    return result


def _default_session_id() -> str:
    return os.environ.get("PERSONAL_AGENT_SESSION_ID", "unknown")


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True, slots=True)
class LogRecord:
    schema_version: int
    id: str
    ts: str
    level: str
    source: str
    event: str
    message: str
    fingerprint: str
    session_id: str
    code: str | None = None
    stack: str | None = None
    task_id: str | None = None
    trace_id: str | None = None
    duration_ms: float | None = None
    context: dict[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "schemaVersion": self.schema_version,
            "id": self.id,
            "ts": self.ts,
            "level": self.level,
            "source": self.source,
            "event": self.event,
            "message": self.message,
            "fingerprint": self.fingerprint,
            "sessionId": self.session_id,
        }
        optional = {
            "code": self.code,
            "stack": self.stack,
            "taskId": self.task_id,
            "traceId": self.trace_id,
            "durationMs": self.duration_ms,
            "context": self.context,
        }
        for key, value in optional.items():
            if value is not None:
                wire[key] = value
        return wire


def build_record(
    level: int | str,
    event: str,
    message: str,
    *,
    code: str | None = None,
    task_id: str | None = None,
    trace_id: str | None = None,
    duration_ms: float | None = None,
    context: dict[str, Any] | None = None,
    session_id: str | None = None,
    stack: str | None = None,
    exc: BaseException | None = None,
) -> LogRecord:
    source = "python"
    resolved_level = python_level_to_log_level(level)

    raw_message = message
    raw_stack = stack
    if exc is not None:
        if not raw_message:
            raw_message = str(exc)
        if raw_stack is None:
            raw_stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))

    text = _truncate(redact_text(raw_message or ""), MESSAGE_CHARS)
    stack_text = None if raw_stack is None else _truncate(redact_text(raw_stack), STACK_CHARS)

    return LogRecord(
        schema_version=SCHEMA_VERSION,
        id=str(uuid.uuid4()),
        ts=_now_iso(),
        level=resolved_level,
        source=source,
        event=event.strip(),
        message=text,
        fingerprint=compute_fingerprint(
            source=source,
            event=event.strip(),
            code=code,
            message=text,
            stack=stack_text,
        ),
        session_id=session_id or _default_session_id(),
        code=code or None,
        stack=stack_text,
        task_id=task_id,
        trace_id=trace_id,
        duration_ms=duration_ms,
        context=sanitize_context(context),
    )


def write_frame(stream: TextIO, record: LogRecord, session_id: str | None = None) -> None:
    import json

    payload = record.to_wire()
    if session_id:
        payload["sessionId"] = session_id
    stream.write(PYTHON_LOG_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    stream.flush()
