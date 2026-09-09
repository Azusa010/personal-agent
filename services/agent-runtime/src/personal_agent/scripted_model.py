"""Scripted_model - 默认的ModelGateway实现"""

from collections.abc import Sequence

from personal_agent.model_gateway import ModelContext, ModelDecision, ScriptExhausted


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
