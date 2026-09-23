"""ContextManager —— 观察历史与 ModelContext 组装。

只做一个字符预算的旋钮，不做「保留最近 N 条」的滑动窗口：
observation 的条数已经被步数预算钉死（engine 侧），再叠一层窗口只是
重复预算已经保证的事，还多一种失败模式 —— 静默丢掉模型正需要的早期观察。
真正无上界的是单条的大小（一份 500 页的 PDF）。
"""

import json
import os
from collections.abc import Sequence
from typing import Any

from personal_agent.conversation.compression import (
    DistilledObservation,
    ObservationDistiller,
    ProgressDocumentManager,
    count_tokens,
    evaluate_window_pressure,
    infer_task_type,
    select_compression_candidates,
)
from personal_agent.conversation.model.gateway import ModelContext, Observation
from personal_agent.conversation.status import StatusBarManager
from personal_agent.protocol.models import PlanStepDto, ProfileDto, Turn

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


DEFAULT_MAX_WINDOW_TOKENS = 128000


class ContextManager:
    """观察历史与 ModelContext 组装。"""

    def __init__(
        self,
        maxCharsPerString: int = DEFAULT_MAX_CHARS_PER_STRING,
        plan: Sequence[PlanStepDto] = (),
        history: Sequence[Turn] = (),
        profile: ProfileDto | None = None,
        max_window_tokens: int = DEFAULT_MAX_WINDOW_TOKENS,
        distiller: ObservationDistiller | None = None,
        doc_manager: ProgressDocumentManager | None = None,
        task_goal: str = "",
        max_window_chars: int | None = None,
        status_bar_manager: StatusBarManager | None = None,
    ) -> None:
        if maxCharsPerString < 1:
            raise ValueError(f"maxCharsPerString 必须 >= 1，收到 {maxCharsPerString}")
        self._maxCharsPerString = maxCharsPerString
        self._plan: list[PlanStepDto] = list(plan)
        self._observations: list[Observation] = []
        self._history: list[Turn] = list(history)
        self._profile = profile
        self._current_step: PlanStepDto | None = None
        self._step_observations: list[Observation] = []
        if max_window_chars is not None:
            self._max_window_tokens = max_window_chars
        else:
            env_val = os.environ.get("PERSONAL_AGENT_MAX_WINDOW_TOKENS", "").strip()
            if env_val and env_val.isdigit():
                self._max_window_tokens = int(env_val)
            else:
                self._max_window_tokens = max_window_tokens
        self._distiller = distiller or ObservationDistiller()
        if doc_manager is not None:
            self._doc_manager = doc_manager
        elif task_goal:
            self._doc_manager = ProgressDocumentManager(
                task_goal=task_goal,
                task_type=infer_task_type(task_goal),
            )
        else:
            self._doc_manager = None
        self._distilled_cache: dict[str, DistilledObservation] = {}
        self._status_bar_manager = status_bar_manager or StatusBarManager()
        if self._plan:
            self._status_bar_manager.init_from_plan(self._plan)

    @property
    def status_bar_manager(self) -> StatusBarManager:
        return self._status_bar_manager

    @property
    def doc_manager(self) -> ProgressDocumentManager | None:
        return self._doc_manager

    @property
    def distiller(self) -> ObservationDistiller:
        return self._distiller

    @property
    def observations(self) -> tuple[Observation, ...]:
        """只读快照。返回 tuple 而不是内部 list，调用方 append 不进去。"""
        return tuple(self._observations)

    @property
    def plan(self) -> tuple[PlanStepDto, ...]:
        """只读快照，与 observations 同一条规矩。engine 拿它判定摘要要不要
        强制页码（计划里有 extract_pdf 才强制）。"""
        return tuple(self._plan)

    @property
    def step_observations(self) -> tuple[Observation, ...]:
        """当前步骤的观察快照。PlanAndExecute 用它构建步骤级上下文。"""
        return tuple(self._step_observations)

    @property
    def current_step(self) -> PlanStepDto | None:
        """当前步骤。None 表示不在 PlanAndExecute 模式。"""
        return self._current_step

    def set_current_step(self, step: PlanStepDto | None) -> None:
        """PlanAndExecute 策略每推进一步就调一次。

        重置步骤级观察，同时保留全局观察（_observations 不清）。
        纯 ReAct 和 Classic 不调这个方法，_current_step 始终为 None。
        """
        self._current_step = step
        self._step_observations = []

    def update_plan(self, plan: Sequence[PlanStepDto]) -> None:
        """重规划（Re-planning）后替换计划。保留已有的 observations。"""
        self._plan = list(plan)
        self._status_bar_manager.init_from_plan(self._plan)

    def record(self, observation: Observation) -> None:
        self._observations.append(observation)
        self._step_observations.append(observation)
        self._status_bar_manager.record_tool_call(observation.capability)

    def build(self, taskGoal: str, visibleCapabilities: Sequence[str]) -> ModelContext:
        # 1. 确保工作文档管理器初始化
        if self._doc_manager is None:
            task_type = infer_task_type(taskGoal)
            self._doc_manager = ProgressDocumentManager(
                task_goal=taskGoal,
                task_type=task_type,
            )

        # 2. 统计当前窗口负载（历史 + 计划 + 观察原始 Token 数）
        current_tokens = (
            sum(count_tokens(t.text) for t in self._history)
            + sum(
                count_tokens(json.dumps(obs.payload, ensure_ascii=False))
                for obs in self._observations
            )
            + count_tokens(taskGoal)
        )

        # 3. 检查主 Agent 窗口负载率是否超警戒线
        if evaluate_window_pressure(
            current_tokens=current_tokens,
            max_window_tokens=self._max_window_tokens,
            ratio_threshold=0.75,
        ):
            _cand_turns, cand_obs = select_compression_candidates(
                history=self._history,
                observations=self._observations,
                keep_recent_turns=2,
                keep_recent_obs=1,
            )
            for obs in cand_obs:
                if obs.callId not in self._distilled_cache:
                    step_desc = (
                        self._current_step.description if self._current_step else ""
                    )
                    distilled = self._distiller.distill_observation(
                        observation=obs,
                        query=step_desc or obs.capability,
                        context=self._doc_manager.render(),
                        task_type=self._doc_manager.state.taskType,
                    )
                    self._distilled_cache[obs.callId] = distilled
                    if distilled.facts:
                        self._doc_manager.merge_facts(distilled.facts)
                    if distilled.tier.value == "ephemeral_l0":
                        self._doc_manager.add_milestone(distilled.summary)

        # 4. 构建 observations，命中提炼缓存的使用精简 payload
        observations = []
        for observation in self._observations:
            if observation.callId in self._distilled_cache:
                cached = self._distilled_cache[observation.callId]
                observations.append(
                    Observation(
                        callId=observation.callId,
                        capability=observation.capability,
                        ok=observation.ok,
                        payload={"summary": cached.summary, "distilled": True},
                        arguments=observation.arguments,
                    )
                )
            else:
                value = truncate_strings(observation.payload, self._maxCharsPerString)
                args_val = truncate_strings(observation.arguments, self._maxCharsPerString)
                observations.append(
                    Observation(
                        callId=observation.callId,
                        capability=observation.capability,
                        ok=observation.ok,
                        payload=value,
                        arguments=args_val if isinstance(args_val, dict) else observation.arguments,
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

        doc_content = None
        if self._doc_manager and (
            self._doc_manager.state.verifiedFacts
            or self._doc_manager.state.milestones
            or self._doc_manager.state.notes
        ):
            doc_content = self._doc_manager.render()

        sb_text = self._status_bar_manager.render()

        return ModelContext(
            taskGoal=taskGoal,
            visibleCapabilities=visibleCapabilities,
            plan=plan,
            observations=observations,
            history=history,
            profile=self._profile,
            progressDocument=doc_content,
            statusBar=sb_text if sb_text else None,
        )
