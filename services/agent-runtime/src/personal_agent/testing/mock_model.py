"""testing/mock_model.py —— 确定性测试替身模型（MockModel / ScriptedModel）。

用于 CI 门禁与离线回归，按预设的 JSON 剧本逐步产出决策，不消耗网络与 API Token。
"""

import json
from collections.abc import Sequence
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from personal_agent.conversation.model.gateway import (
    ModelContext,
    ModelDecision,
    ScriptExhausted,
    ThinkingSink,
)
from personal_agent.shared.stream import (
    THINKING_CHUNK_PAUSE_SECONDS,
    emit_thinking_chunks,
)

SCRIPT_ADAPTER: TypeAdapter[list[ModelDecision]] = TypeAdapter(list[ModelDecision])


class ScriptLoadError(ValueError):
    """剧本文件读不出来，或者读出来了但不是 ModelDecision 数组。"""


class ScriptedModel:
    """按预设序列逐步吐出决策的确定性模型。"""

    def __init__(
        self,
        decisions: Sequence[ModelDecision],
        thinking_pause_seconds: float = THINKING_CHUNK_PAUSE_SECONDS,
    ) -> None:
        self._decisions: list[ModelDecision] = list(decisions)
        self._cursor = 0
        self._thinking_pause_seconds = thinking_pause_seconds
        self.receivedContexts: list[ModelContext] = []

    def decide(
        self, context: ModelContext, on_thinking: ThinkingSink | None = None
    ) -> ModelDecision:
        self.receivedContexts.append(context)
        if self._cursor >= len(self._decisions):
            raise ScriptExhausted(len(self._decisions))
        decision = self._decisions[self._cursor]
        self._cursor += 1
        if on_thinking is not None and decision.thinking:
            emit_thinking_chunks(
                decision.thinking, on_thinking, self._thinking_pause_seconds
            )
        return decision

    @property
    def remaining(self) -> int:
        return len(self._decisions) - self._cursor


# 别名，在测试编写中更具语义
MockModel = ScriptedModel


def load_script(path: str | Path) -> list[ModelDecision]:
    """把一个 JSON 剧本文件读成决策序列。"""
    script_path = Path(path)
    try:
        raw = script_path.read_text(encoding="utf-8")
    except OSError as e:
        raise ScriptLoadError(f"剧本文件读不出来: {script_path} ({e})") from e

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ScriptLoadError(f"剧本不是合法 JSON: {script_path} ({e})") from e

    try:
        return SCRIPT_ADAPTER.validate_python(data)
    except ValidationError as e:
        raise ScriptLoadError(
            f"剧本不符合 ModelDecision 契约: {script_path} ({e})"
        ) from e