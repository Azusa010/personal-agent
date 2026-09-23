"""压缩策略与分流器：主 Agent 上下文窗口水位监控、候选选取与任务模式自适应。"""

from collections.abc import Sequence

from personal_agent.conversation.compression.models import (
    LifecycleTier,
    TaskType,
)
from personal_agent.conversation.model.gateway import Observation
from personal_agent.protocol.models import Turn

DEFAULT_RATIO_THRESHOLD = 0.75
DEFAULT_KEEP_RECENT_TURNS = 2
DEFAULT_KEEP_RECENT_OBS = 1


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


def infer_task_type(task_goal: str) -> TaskType:
    """根据任务目标文本自适应识别任务意图模式。
    # TODO 可选用Jev模型实    验
    """
    goal = task_goal.lower()
    analytical_keywords = ("分析", "为什么", "评估", "对比", "原因", "深度", "影响")
    creative_keywords = ("创作", "设计", "构思", "写一段", "生成故事", "灵感", "宣传语")

    if any(k in goal for k in analytical_keywords):
        return TaskType.ANALYTICAL
    if any(k in goal for k in creative_keywords):
        return TaskType.CREATIVE
    return TaskType.RETRIEVAL


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
