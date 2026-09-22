"""personal_agent.conversation.status —— 状态栏与上下文工程模块。"""

from personal_agent.conversation.status.models import (
    StatusBarState,
    SystemEnvironment,
    TodoItem,
    TodoStatus,
    ToolCounterState,
)
from personal_agent.conversation.status.providers import (
    StatusBarSectionProvider,
    SystemInfoProvider,
    TodoPlanProvider,
    ToolStatsProvider,
    detect_system_environment,
)
from personal_agent.conversation.status.renderer import (
    STATUS_BAR_CLOSE_TAG,
    STATUS_BAR_OPEN_TAG,
    StatusBarRenderer,
)
from personal_agent.conversation.status.strategy import (
    DEFAULT_ALPHA,
    DEFAULT_MAX_APPEND_TURNS,
    DEFAULT_MAX_CONTEXT_RATIO,
    InjectionStrategy,
    evaluate_injection_strategy,
)
from personal_agent.conversation.status.tracker import (
    ToolCallTracker,
    format_timestamp,
    prefix_with_timestamp,
)

__all__ = [
    "TodoStatus",
    "TodoItem",
    "ToolCounterState",
    "SystemEnvironment",
    "StatusBarState",
    "ToolCallTracker",
    "format_timestamp",
    "prefix_with_timestamp",
    "detect_system_environment",
    "StatusBarSectionProvider",
    "SystemInfoProvider",
    "ToolStatsProvider",
    "TodoPlanProvider",
    "StatusBarRenderer",
    "STATUS_BAR_OPEN_TAG",
    "STATUS_BAR_CLOSE_TAG",
    "InjectionStrategy",
    "evaluate_injection_strategy",
    "DEFAULT_ALPHA",
    "DEFAULT_MAX_APPEND_TURNS",
    "DEFAULT_MAX_CONTEXT_RATIO",
]
