"""Scripted_model - 默认的ModelGateway实现"""

import json
from collections.abc import Sequence
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from personal_agent.model_gateway import ModelContext, ModelDecision, ScriptExhausted

SCRIPT_ADAPTER: TypeAdapter[list[ModelDecision]] = TypeAdapter(list[ModelDecision])


class ScriptLoadError(ValueError):
    """剧本文件读不出来，或者读出来了但不是 ModelDecision 数组。"""


class ScriptedModel:
    """按预设序列逐步吐出决策的确定性模型。"""

    def __init__(self, decisions: Sequence[ModelDecision]) -> None:
        self._decisions: list[ModelDecision] = list(decisions)
        self._cursor = 0
        self.receivedContexts: list[ModelContext] = []

    def decide(self, context: ModelContext) -> ModelDecision:
        self.receivedContexts.append(context)
        if self._cursor >= len(self._decisions):
            raise ScriptExhausted(len(self._decisions))
        decision = self._decisions[self._cursor]
        self._cursor += 1
        return decision

    @property
    def remaining(self) -> int:
        return len(self._decisions) - self._cursor


def load_script(path: str | Path) -> list[ModelDecision]:
    """
    把一个 JSON 剧本文件读成决策序列。
    """
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
        raise ScriptLoadError(f"剧本不符合 ModelDecision 契约: {script_path} ({e})") from e