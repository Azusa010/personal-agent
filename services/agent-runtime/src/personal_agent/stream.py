"""
把模型的产出转换成可读的流式输出
"""

import logging
import time
from collections.abc import Callable
from typing import Protocol

from personal_agent.protocol.models import AGENT_STREAM, RunTaskEvent

log = logging.getLogger(__name__)

THINKING_CHUNK_CHARS = 24
THINKING_CHUNK_PAUSE_SECONDS = 0.05


class StreamSink(Protocol):
    def event(self, event: RunTaskEvent) -> None: ...
    def thinking(self, delta: str) -> None: ...


def event_notice(task_id: str, event: RunTaskEvent) -> dict:
    return {
        "jsonrpc": "2.0",
        "method": AGENT_STREAM,
        "params": {
            "kind": "event",
            "taskId": task_id,
            "event": event.model_dump(),
        },
    }


def thinking_notice(task_id: str, delta: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "method": AGENT_STREAM,
        "params": {"kind": "thinking", "taskId": task_id, "delta": delta},
    }


def chunk_text(text: str, size: int) -> list[str]:
    """把一段文本按固定大小切开。空文本给空列表"""
    if size < 1:
        raise ValueError(f"chunk size 必须 >= 1，收到 {size}")
    return [text[index : index + size] for index in range(0, len(text), size)]


class StreamEmitter:
    """一次任务一份：把事件与思维增量按通知形状写出去。

    write_msg 在生产路径上是 runtime.write（写 stdout）
    """

    def __init__(self, write_msg: Callable[[dict], None], task_id: str) -> None:
        self._write_msg = write_msg
        self._task_id = task_id

    def event(self, event: RunTaskEvent) -> None:
        self._safe_write(event_notice(self._task_id, event))

    def thinking(self, delta: str) -> None:
        if delta == "":
            return
        self._safe_write(thinking_notice(self._task_id, delta))

    def _safe_write(self, notice: dict) -> None:
        try:
            self._write_msg(notice)
        except Exception:
            log.exception("实时通知写失败，已丢弃")


def emit_thinking_chunks(
    text: str,
    sink: Callable[[str], None],
    pause_seconds: float = THINKING_CHUNK_PAUSE_SECONDS,
) -> None:
    """按固定粒度把一段文本喂给 sink，块间停顿 pause_seconds。"""
    chunks = chunk_text(text, THINKING_CHUNK_CHARS)
    for index, chunk in enumerate(chunks):
        if index > 0 and pause_seconds > 0:
            time.sleep(pause_seconds)
        sink(chunk)
