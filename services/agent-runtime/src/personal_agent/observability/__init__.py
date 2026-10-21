"""错误日志：记录构造、脱敏、指纹与 stderr 帧发射。"""

from __future__ import annotations

from personal_agent.observability.record import (
    CONTEXT_ARRAY_ITEMS,
    CONTEXT_DEPTH,
    CONTEXT_STRING_CHARS,
    LOG_LEVELS,
    LOG_SOURCES,
    MESSAGE_CHARS,
    NORMALIZED_MESSAGE_CHARS,
    PYTHON_LOG_PREFIX,
    SCHEMA_VERSION,
    STACK_CHARS,
    TOP_FRAME_CHARS,
    LogRecord,
    build_record,
    compute_fingerprint,
    normalize_message,
    python_level_to_log_level,
    redact_text,
    sanitize_context,
    top_frame,
)

__all__ = [
    "CONTEXT_ARRAY_ITEMS",
    "CONTEXT_DEPTH",
    "CONTEXT_STRING_CHARS",
    "LOG_LEVELS",
    "LOG_SOURCES",
    "MESSAGE_CHARS",
    "NORMALIZED_MESSAGE_CHARS",
    "PYTHON_LOG_PREFIX",
    "SCHEMA_VERSION",
    "STACK_CHARS",
    "TOP_FRAME_CHARS",
    "LogRecord",
    "build_record",
    "compute_fingerprint",
    "normalize_message",
    "python_level_to_log_level",
    "redact_text",
    "sanitize_context",
    "top_frame",
]
