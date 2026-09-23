"""压缩策略与分流器：主 Agent 上下文窗口水位监控、候选选取与任务模式自适应。"""

import logging
import os
from collections.abc import Sequence
from typing import Any

from personal_agent.conversation.compression.models import (
    LifecycleTier,
    TaskType,
)
from personal_agent.conversation.model.gateway import Observation
from personal_agent.protocol.models import Turn

DEFAULT_RATIO_THRESHOLD = 0.75
DEFAULT_KEEP_RECENT_TURNS = 2
DEFAULT_KEEP_RECENT_OBS = 1

log = logging.getLogger("personal_agent")

TASK_TYPE_CHOICE_MAP: dict[str, TaskType] = {
    "retrieval": TaskType.RETRIEVAL,
    "analytical": TaskType.ANALYTICAL,
    "creative": TaskType.CREATIVE,
}


def evaluate_window_pressure(
    current_tokens: int,
    max_window_tokens: int,
    ratio_threshold: float = DEFAULT_RATIO_THRESHOLD,
) -> bool:
    """判定主 Agent 当前上下文窗口负载率是否越过警戒水位。
    """
    if current_tokens < 0 or max_window_tokens <= 0:
        raise ValueError()
    if not (0.0 <= ratio_threshold <= 1.0):
        raise ValueError()

    return current_tokens / max_window_tokens >= ratio_threshold


def select_compression_candidates(
    history: Sequence[Turn],
    observations: Sequence[Observation],
    keep_recent_turns: int = DEFAULT_KEEP_RECENT_TURNS,
    keep_recent_obs: int = DEFAULT_KEEP_RECENT_OBS,
) -> tuple[list[Turn], list[Observation]]:
    """从会话历史与工具观察中筛选待压缩目标，严格保留近期活跃交互窗口。
    """
    if len(history) <= keep_recent_turns:
        early_turns = []
    else:
        early_turns = list(history[:-keep_recent_turns])
    if len(observations) <= keep_recent_obs:
        early_observations = []
    else:
        early_observations = list(observations[:-keep_recent_obs])
    return early_turns, early_observations


def _infer_task_type_heuristic(task_goal: str) -> TaskType:
    """纯离线规则分流：基于关键词启发式匹配任务意图。"""
    goal = task_goal.lower()
    analytical_keywords = ("分析", "为什么", "评估", "对比", "原因", "深度", "影响")
    creative_keywords = ("创作", "设计", "构思", "写一段", "生成故事", "灵感", "宣传语")

    if any(k in goal for k in analytical_keywords):
        return TaskType.ANALYTICAL
    if any(k in goal for k in creative_keywords):
        return TaskType.CREATIVE
    return TaskType.RETRIEVAL


def infer_task_type(task_goal: str, client: Any | None = None) -> TaskType:
    """根据任务目标文本自适应识别任务意图模式。

    优先使用 TypeSafe AI 的 Jev 决策模型（System One 极速结构化分类）；
    若未配置 API Key、显式 client 为空、网络异常或返回非法选项，平滑降级至本地启发式规则。
    """
    jev_client = client
    if jev_client is None:
        api_key = os.environ.get("TYPESAFE_API_KEY", "").strip()
        if api_key:
            try:
                from typesafe_sdk import TypeSafeClient

                jev_client = TypeSafeClient()
            except Exception as err:  # noqa: BLE001
                log.warning("TypeSafeClient 实例化失败，降级为启发式规则: %s", err)

    if jev_client is not None:
        from typesafe_sdk import Choice

        try:
            response = jev_client.system_one(
                state={"task_goal": task_goal},
                questions={
                    "task_type": Choice(
                        instructions="请根据任务目标文本判断其意图类型，选择最符合的分类。",
                        criteria={
                            "retrieval": "任务目标主要涉及信息检索、数据查询或事实获取。",
                            "analytical": "任务目标主要涉及分析、评估、对比或解释原因。",
                            "creative": "任务目标主要涉及创作、设计、构思或生成内容。",
                        },
                    )
                },
            )
            answer = response.answers["task_type"].choice
            return TASK_TYPE_CHOICE_MAP.get(answer, _infer_task_type_heuristic(task_goal))
        except Exception as err:  # noqa: BLE001
            log.warning("调用 Jev 模型失败，降级为启发式规则: %s", err)
    return _infer_task_type_heuristic(task_goal)


def classify_lifecycle(capability: str) -> LifecycleTier:
    """根据工具能力特性划分生命周期分层。"""
    ephemeral_tools = {
        "terminal_execute",
        "filesystem_create_dir",
        "filesystem_move",
        "scheduler_create",
        "notification_send",
    }
    if capability in ephemeral_tools:
        return LifecycleTier.EPHEMERAL_L0
    return LifecycleTier.TASK_SCOPED_L1
