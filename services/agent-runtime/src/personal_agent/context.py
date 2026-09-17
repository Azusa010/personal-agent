"""ContextManager —— 观察历史与 ModelContext 组装。

只做一个字符预算的旋钮，不做「保留最近 N 条」的滑动窗口：
observation 的条数已经被步数预算钉死（engine 侧），再叠一层窗口只是
重复预算已经保证的事，还多一种失败模式 —— 静默丢掉模型正需要的早期观察。
真正无上界的是单条的大小（一份 500 页的 PDF）。
"""

from collections.abc import Sequence
from pydoc import text
from typing import Any

from personal_agent.model_gateway import ModelContext, Observation
from personal_agent.protocol.models import PlanStepDto, Turn

# 一页 A4 文本约 2000-4000 字符。12 页 × 2000 ≈ 24k 字符 ≈ 6k token，
# 真实模型的窗口装得下；ScriptedModel 不读内容，CI 确定性不受影响。
# 这个值不进 wire（RunTaskParams 只有 taskId 与 goal），也不从环境变量读：
DEFAULT_MAX_CHARS_PER_STRING = 2000

TRUNCATION_MARKER = "…[truncated]"

# 只有这里的 key 所对应的字符串会被截。
# 白名单而不是黑名单：新增 capability 的字段默认不截断（顶多上下文偏长），
# 而不是默认截断（code / name / absolutePath 这类标识符被啃坏，任务静默失败）。
TRUNCATABLE_KEYS = frozenset({"text", "reason"})


def _walk(value: Any, limit: int, key: str | None) -> Any:
    if isinstance(value, str) and (key in TRUNCATABLE_KEYS or key is None):
        if len(value) <= limit:
            return value
        return value[:limit] + TRUNCATION_MARKER
    if isinstance(value, dict):
        return {k: _walk(v, limit, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_walk(v, limit, key) for v in value]
    if isinstance(value, tuple):
        return tuple(_walk(v, limit, key) for v in value)
    return value


def truncate_strings(value: Any, limit: int) -> Any:
    return _walk(value, limit, None)


class ContextManager:
    """保存原始观察，按需组装出截断过的 ModelContext。"""

    def __init__(
        self,
        maxCharsPerString: int = DEFAULT_MAX_CHARS_PER_STRING,
        plan: Sequence[PlanStepDto] = (),
        history: Sequence[Turn] = (),
    ) -> None:
        if maxCharsPerString < 1:
            raise ValueError(f"maxCharsPerString 必须 >= 1，收到 {maxCharsPerString}")
        self._maxCharsPerString = maxCharsPerString
        self._plan: list[PlanStepDto] = list(plan)
        self._observations: list[Observation] = []
        self._history: list[Turn] = list(history)

    @property
    def observations(self) -> tuple[Observation, ...]:
        """只读快照。返回 tuple 而不是内部 list，调用方 append 不进去。"""
        return tuple(self._observations)

    @property
    def plan(self) -> tuple[PlanStepDto, ...]:
        """只读快照，与 observations 同一条规矩。engine 拿它判定摘要要不要
        强制页码（计划里有 extract_pdf 才强制）。"""
        return tuple(self._plan)

    def record(self, observation: Observation) -> None:
        self._observations.append(observation)

    def build(self, taskGoal: str, visibleCapabilities: Sequence[str]) -> ModelContext:
        observations = []
        for observation in self._observations:
            value = truncate_strings(observation.payload, self._maxCharsPerString)
            observations.append(
                Observation(
                    callId=observation.callId,
                    capability=observation.capability,
                    ok=observation.ok,
                    payload=value,
                )
            )
        plan = [
            PlanStepDto(
                description=truncate_strings(step.description, self._maxCharsPerString),
                capability=step.capability,
            )
            for step in self._plan
        ]
        history = [
            Turn(
                role=turn.role,
                text=truncate_strings(turn.text, self._maxCharsPerString),
            )
            for turn in self._history
        ]
        return ModelContext(
            taskGoal=taskGoal,
            visibleCapabilities=visibleCapabilities,
            plan=plan,
            observations=observations,
            history=history,
        )
