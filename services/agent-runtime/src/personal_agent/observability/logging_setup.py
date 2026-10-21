"""stdlib logging 接线与未捕获异常钩子。"""

from __future__ import annotations

import contextlib
import logging
import sys
import traceback
from types import TracebackType

from personal_agent.observability.emitter import StderrEmitter
from personal_agent.observability.record import build_record, python_level_to_log_level

_HANDLER_MARKER = "_personal_agent_observability"


class _EmitterHandler(logging.Handler):
    def __init__(self, emitter: StderrEmitter) -> None:
        super().__init__()
        self._emitter = emitter

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = python_level_to_log_level(record.levelno)
            event = f"python.log.{record.levelname.lower()}"
            self._emitter.emit(build_record(level, event, record.getMessage()))
        except Exception:  # noqa: BLE001 - 日志链路不得反噬被记录的调用方
            self.handleError(record)


def configure_logging(
    emitter: StderrEmitter,
    level: int | str = logging.INFO,
    target: logging.Logger | None = None,
) -> logging.Handler:
    logger = logging.getLogger() if target is None else target

    for handler in list(logger.handlers):
        if getattr(handler, _HANDLER_MARKER, False):
            logger.removeHandler(handler)
            handler.close()

    bridge = _EmitterHandler(emitter)
    setattr(bridge, _HANDLER_MARKER, True)
    logger.addHandler(bridge)
    logger.setLevel(level)
    return bridge


def install_exception_hooks(emitter: StderrEmitter) -> object:
    previous = sys.excepthook

    def hook(
        exc_type: type[BaseException],
        exc_value: BaseException,
        exc_tb: TracebackType | None,
    ) -> None:
        with contextlib.suppress(Exception):
            emitter.emit(
                build_record(
                    "fatal",
                    "process.uncaught_exception",
                    "",
                    exc=exc_value,
                    stack="".join(traceback.format_exception(exc_type, exc_value, exc_tb)),
                )
            )
        previous(exc_type, exc_value, exc_tb)

    sys.excepthook = hook

    def restore() -> None:
        sys.excepthook = previous

    return restore
