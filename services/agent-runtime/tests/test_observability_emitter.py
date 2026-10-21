"""错误日志：Python → stderr 帧发射、logging 接线与全局异常钩子。

规格：docs/ERROR_LOG_SYSTEM_SPEC.md §5 / §13.9

契约要点：
- 一行一帧，前缀 `@@PALOG@@` 紧跟 JSON，不得出现真实换行；
- 序列化保留中文（ensure_ascii=False）；
- 编码/写入失败必须降级而不是抛出（日志不得反噬业务）；
- 全局异常钩子先记 fatal，再委托原钩子，不得吞掉原有行为。
"""

from __future__ import annotations

import io
import json
import logging
import sys

import pytest

from personal_agent.observability import PYTHON_LOG_PREFIX, build_record
from personal_agent.observability.emitter import StderrEmitter
from personal_agent.observability.logging_setup import (
    configure_logging,
    install_exception_hooks,
)


def decode_frame(line: str) -> dict:
    assert line.startswith(PYTHON_LOG_PREFIX), "帧必须带魔数前缀"
    return json.loads(line[len(PYTHON_LOG_PREFIX) :])


@pytest.fixture()
def root_handlers():
    root = logging.getLogger()
    saved = list(root.handlers)
    saved_level = root.level
    yield root
    for handler in list(root.handlers):
        if handler not in saved:
            root.removeHandler(handler)
            handler.close()
    root.setLevel(saved_level)


class TestStderrEmitter:
    def test_writes_single_prefixed_line(self) -> None:
        stream = io.StringIO()
        emitter = StderrEmitter(stream=stream)

        emitter.emit(build_record("error", "tool.execute.failed", "命令执行失败"))

        raw = stream.getvalue()
        assert raw.endswith("\n")
        assert raw.count("\n") == 1
        payload = decode_frame(raw.rstrip("\n"))
        assert payload["level"] == "error"
        assert payload["source"] == "python"
        assert payload["event"] == "tool.execute.failed"
        assert payload["message"] == "命令执行失败"

    def test_message_with_newline_stays_single_line(self) -> None:
        stream = io.StringIO()
        emitter = StderrEmitter(stream=stream)

        emitter.emit(build_record("error", "e", "line1\nline2\r\nline3"))

        raw = stream.getvalue()
        assert raw.count("\n") == 1
        assert decode_frame(raw.rstrip("\n"))["message"] == "line1\nline2\r\nline3"

    def test_keeps_chinese_readable(self) -> None:
        stream = io.StringIO()
        emitter = StderrEmitter(stream=stream)

        emitter.emit(build_record("warn", "e", "中文不应被转义成 \\u 序列"))

        raw = stream.getvalue()
        assert "中文不应被转义成" in raw
        assert "\\u4e2d" not in raw

    def test_frame_carries_fingerprint_and_session(self) -> None:
        stream = io.StringIO()
        emitter = StderrEmitter(stream=stream, session_id="session-9")

        emitter.emit(build_record("error", "e", "boom", task_id="task-3"))

        payload = decode_frame(stream.getvalue().rstrip("\n"))
        assert len(payload["fingerprint"]) == 40
        assert payload["sessionId"] == "session-9"
        assert payload["taskId"] == "task-3"

    def test_unicode_encode_error_does_not_raise(self) -> None:
        class BrokenStream(io.StringIO):
            def write(self, s: str) -> int:  # type: ignore[override]
                raise UnicodeEncodeError("utf-8", "x", 0, 1, "boom")

        emitter = StderrEmitter(stream=BrokenStream())

        emitter.emit(build_record("error", "e", "boom"))

    def test_io_error_does_not_raise(self) -> None:
        class BrokenStream(io.StringIO):
            def write(self, s: str) -> int:  # type: ignore[override]
                raise OSError("EPIPE")

        emitter = StderrEmitter(stream=BrokenStream())

        emitter.emit(build_record("error", "e", "boom"))


class TestConfigureLogging:
    def test_stdlib_logger_emits_frames(self, root_handlers: logging.Logger) -> None:
        stream = io.StringIO()
        configure_logging(StderrEmitter(stream=stream))

        logging.getLogger("observability-test").error("数据库连接失败")

        payload = decode_frame(stream.getvalue().rstrip("\n"))
        assert payload["level"] == "error"
        assert "数据库连接失败" in payload["message"]

    def test_level_mapping_warning(self, root_handlers: logging.Logger) -> None:
        stream = io.StringIO()
        configure_logging(StderrEmitter(stream=stream))

        logging.getLogger("observability-test").warning("磁盘将满")

        assert decode_frame(stream.getvalue().rstrip("\n"))["level"] == "warn"

    def test_debug_filtered_at_info(self, root_handlers: logging.Logger) -> None:
        stream = io.StringIO()
        configure_logging(StderrEmitter(stream=stream), level=logging.INFO)

        logging.getLogger("observability-test").debug("不应出现")

        assert stream.getvalue() == ""

    def test_debug_kept_at_debug(self, root_handlers: logging.Logger) -> None:
        stream = io.StringIO()
        configure_logging(StderrEmitter(stream=stream), level=logging.DEBUG)

        logging.getLogger("observability-test").debug("应当出现")

        assert "应当出现" in stream.getvalue()

    def test_secrets_are_redacted_before_framing(self, root_handlers: logging.Logger) -> None:
        stream = io.StringIO()
        configure_logging(StderrEmitter(stream=stream))

        logging.getLogger("observability-test").error(
            "请求失败 api_key=sk-abcdefghijklmnopqrstuvwx"
        )

        raw = stream.getvalue()
        assert "sk-abcdefghijklmnopqrstuvwx" not in raw
        assert "api_key=***" in raw


class TestExceptionHooks:
    def test_uncaught_exception_emits_fatal_and_delegates(self) -> None:
        stream = io.StringIO()
        emitter = StderrEmitter(stream=stream)
        delegated: list[BaseException] = []

        original = sys.excepthook

        def fake_hook(exc_type, exc_value, exc_tb):
            delegated.append(exc_value)

        sys.excepthook = fake_hook
        restore = install_exception_hooks(emitter)
        try:
            try:
                raise ValueError("hooked boom")
            except ValueError:
                sys.excepthook(*sys.exc_info())
        finally:
            restore()
            sys.excepthook = original

        payload = decode_frame(stream.getvalue().rstrip("\n"))
        assert payload["level"] == "fatal"
        assert payload["event"] == "process.uncaught_exception"
        assert "ValueError: hooked boom" in payload["stack"]
        assert len(delegated) == 1
        assert str(delegated[0]) == "hooked boom"

    def test_restore_puts_original_hook_back(self) -> None:
        emitter = StderrEmitter(stream=io.StringIO())
        original = sys.excepthook

        restore = install_exception_hooks(emitter)
        assert sys.excepthook is not original

        restore()
        assert sys.excepthook is original

    def test_hook_survives_broken_stream(self) -> None:
        class BrokenStream(io.StringIO):
            def write(self, s: str) -> int:  # type: ignore[override]
                raise OSError("EPIPE")

        emitter = StderrEmitter(stream=BrokenStream())
        delegated: list[BaseException] = []
        original = sys.excepthook

        sys.excepthook = lambda exc_type, exc_value, exc_tb: delegated.append(exc_value)
        restore = install_exception_hooks(emitter)
        try:
            try:
                raise RuntimeError("boom")
            except RuntimeError:
                sys.excepthook(*sys.exc_info())
        finally:
            restore()
            sys.excepthook = original

        assert len(delegated) == 1
