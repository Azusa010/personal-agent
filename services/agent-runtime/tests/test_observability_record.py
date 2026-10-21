"""错误日志：记录构造、脱敏与指纹（与 TS 共享 fixture）。

规格：docs/ERROR_LOG_SYSTEM_SPEC.md §4 / §6 / §7 / §8 / §13.9

本文件的 redaction / fingerprint 用例直接读取
`packages/protocol/fixtures/logging/*.json`，与
`apps/desktop/tests/main/observability/redactor.test.ts`、
`log-record.test.ts` 使用同一份期望值——任何一端算法漂移都会在这里爆红。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from personal_agent.observability import (
    PYTHON_LOG_PREFIX,
    build_record,
    compute_fingerprint,
    normalize_message,
    python_level_to_log_level,
    redact_text,
    top_frame,
)
from personal_agent.protocol.models import LogRecordModel

REPO_ROOT = Path(__file__).resolve().parents[3]
LOGGING_FIXTURES = REPO_ROOT / "packages" / "protocol" / "fixtures" / "logging"

REDACTION_CASES = json.loads(
    (LOGGING_FIXTURES / "redaction-cases.json").read_text(encoding="utf-8")
)["cases"]
FINGERPRINT_CASES = json.loads(
    (LOGGING_FIXTURES / "fingerprint-cases.json").read_text(encoding="utf-8")
)["cases"]


def case_by_name(name: str) -> dict:
    for item in FINGERPRINT_CASES:
        if item["name"] == name:
            return item
    raise AssertionError(f"缺少 fixture case: {name}")


def sample_record():
    return build_record(
        "error",
        "tool.execute.failed",
        "命令执行失败",
        code="TERMINAL_EXECUTE_FAILED",
        task_id="task-9",
        session_id="session-1",
    )


class TestRedactionSharedWithTs:
    @pytest.mark.parametrize("case", REDACTION_CASES, ids=[c["name"] for c in REDACTION_CASES])
    def test_matches_shared_fixture(self, case: dict) -> None:
        assert redact_text(case["input"]) == case["expected"]

    @pytest.mark.parametrize("case", REDACTION_CASES, ids=[c["name"] for c in REDACTION_CASES])
    def test_is_idempotent(self, case: dict) -> None:
        once = redact_text(case["input"])
        assert redact_text(once) == once

    def test_benign_text_untouched(self) -> None:
        benign = "任务 42 在第 3 步失败，耗时 1200ms"
        assert redact_text(benign) == benign

    def test_empty_input(self) -> None:
        assert redact_text("") == ""


class TestNormalizeMessage:
    @pytest.mark.parametrize("case", FINGERPRINT_CASES, ids=[c["name"] for c in FINGERPRINT_CASES])
    def test_matches_fixture(self, case: dict) -> None:
        assert normalize_message(case["input"]["message"]) == case["normalizedMessage"]

    def test_numbers_collapse(self) -> None:
        assert normalize_message("failed after 3 retries") == normalize_message(
            "failed after 7 retries"
        )

    def test_uuid_collapses(self) -> None:
        a = normalize_message("task 3f2504e0-4f89-11d3-9a0c-0305e82c3301 aborted")
        b = normalize_message("task 9c1f2b34-1111-2222-3333-444455556666 aborted")
        assert a == b == "task <uuid> aborted"

    def test_length_cap(self) -> None:
        assert len(normalize_message("a" * 500)) == 200

    def test_whitespace_folded(self) -> None:
        assert normalize_message("a  \t b\n c") == "a b c"


class TestTopFrame:
    @pytest.mark.parametrize("case", FINGERPRINT_CASES, ids=[c["name"] for c in FINGERPRINT_CASES])
    def test_matches_fixture(self, case: dict) -> None:
        stack = case["input"].get("stack")
        assert top_frame(stack) == case["topFrame"]

    def test_line_and_column_stripped(self) -> None:
        a = top_frame("Error: x\n    at run (C:\\app\\a.js:1:1)")
        b = top_frame("Error: x\n    at run (C:\\app\\a.js:999:42)")
        assert a == b == "run@a.js"

    def test_missing_stack(self) -> None:
        assert top_frame(None) is None
        assert top_frame("") is None
        assert top_frame("Error: no frames") is None


class TestFingerprint:
    @pytest.mark.parametrize("case", FINGERPRINT_CASES, ids=[c["name"] for c in FINGERPRINT_CASES])
    def test_matches_shared_fixture(self, case: dict) -> None:
        payload = case["input"]
        actual = compute_fingerprint(
            source=payload["source"],
            event=payload["event"],
            code=payload.get("code"),
            message=payload["message"],
            stack=payload.get("stack"),
        )
        assert actual == case["expected"]
        assert re.fullmatch(r"[0-9a-f]{40}", actual)

    def test_variants_share_fingerprint(self) -> None:
        assert case_by_name("retry-count-variant-a")["expected"] == case_by_name(
            "retry-count-variant-b"
        )["expected"]
        assert case_by_name("uuid-a")["expected"] == case_by_name("uuid-b")["expected"]

    def test_different_events_split(self) -> None:
        assert case_by_name("different-event")["expected"] != case_by_name("uuid-a")["expected"]

    def test_level_is_not_part_of_fingerprint(self) -> None:
        a = compute_fingerprint(source="main", event="e", message="m")
        b = compute_fingerprint(source="main", event="e", message="m")
        assert a == b


class TestLevelMapping:
    @pytest.mark.parametrize(
        ("levelno", "expected"),
        [
            (logging.DEBUG, "debug"),
            (logging.INFO, "info"),
            (logging.WARNING, "warn"),
            (logging.ERROR, "error"),
            (logging.CRITICAL, "fatal"),
        ],
    )
    def test_stdlib_levels(self, levelno: int, expected: str) -> None:
        assert python_level_to_log_level(levelno) == expected


class TestBuildRecord:
    def test_required_fields(self) -> None:
        record = sample_record()
        wire = record.to_wire()

        assert wire["schemaVersion"] == 1
        assert wire["level"] == "error"
        assert wire["source"] == "python"
        assert wire["event"] == "tool.execute.failed"
        assert wire["message"] == "命令执行失败"
        assert wire["code"] == "TERMINAL_EXECUTE_FAILED"
        assert wire["taskId"] == "task-9"
        assert wire["sessionId"] == "session-1"
        assert re.fullmatch(r"[0-9a-f]{40}", wire["fingerprint"])
        assert wire["id"]
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", wire["ts"])

    def test_optional_fields_omitted_not_null(self) -> None:
        wire = sample_record().to_wire()

        for key in ("traceId", "durationMs", "stack", "context"):
            assert key not in wire

    def test_level_accepts_stdlib_name(self) -> None:
        record = build_record("WARNING", "e", "m")
        assert record.to_wire()["level"] == "warn"

    def test_message_truncated(self) -> None:
        record = build_record("error", "e", "x" * 5000)
        message = record.to_wire()["message"]

        assert len(message) == 4096
        assert message.endswith("…")

    def test_message_redacted(self) -> None:
        record = build_record("error", "e", "api_key=sk-abcdefghijklmnopqrstuvwx 失败")
        message = record.to_wire()["message"]

        assert "sk-abcdefghijklmnopqrstuvwx" not in message
        assert "api_key=***" in message

    def test_exception_message_and_traceback(self) -> None:
        try:
            raise RuntimeError("boom")
        except RuntimeError as exc:
            record = build_record("error", "e", "", exc=exc)

        wire = record.to_wire()

        assert wire["message"] == "boom"
        assert "RuntimeError: boom" in wire["stack"]
        assert "Traceback" in wire["stack"]

    def test_context_sanitized_and_bounded(self) -> None:
        wire = build_record(
            "error",
            "e",
            "m",
            context={
                "token": "ghp_1234567890abcdefghij",
                "list": list(range(80)),
                "deep": {"a": {"b": {"c": {"d": {"e": "too-deep"}}}}},
            },
        ).to_wire()

        context = wire["context"]
        assert "ghp_1234567890abcdefghij" not in json.dumps(context, ensure_ascii=False)
        assert len(context["list"]) == 50
        assert "<depth-limit>" in json.dumps(context, ensure_ascii=False)

    def test_fingerprint_matches_compute_function(self) -> None:
        record = build_record("error", "tool.call.failed", "tool call failed after 3 retries")
        wire = record.to_wire()

        assert wire["fingerprint"] == compute_fingerprint(
            source="python",
            event="tool.call.failed",
            code=None,
            message="tool call failed after 3 retries",
            stack=None,
        )

    def test_prefix_constant(self) -> None:
        assert PYTHON_LOG_PREFIX == "@@PALOG@@"


class TestPydanticMirror:
    def test_wire_shape_accepted_by_protocol_model(self) -> None:
        wire = sample_record().to_wire()

        model = LogRecordModel.model_validate(wire)

        assert model.level == "error"
        assert model.source == "python"
        assert model.model_dump(exclude_none=True)["event"] == "tool.execute.failed"

    def test_protocol_model_rejects_warning_level(self) -> None:
        wire = sample_record().to_wire()
        wire["level"] = "warning"

        with pytest.raises(ValidationError):
            LogRecordModel.model_validate(wire)
