"""personal_agent.conversation.status —— 状态栏与上下文工程模块。"""

from personal_agent.conversation.status.manager import StatusBarManager
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
from personal_agent.conversation.status.pruner import (
    ContextInvariantViolation,
    is_status_bar_message,
    safe_prune_status_bars,
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
    TIMESTAMP_FORMAT,
    ToolCallTracker,
    format_timestamp,
    prefix_with_timestamp,
)

__all__ = [
    "DEFAULT_ALPHA",
    "DEFAULT_MAX_APPEND_TURNS",
    "DEFAULT_MAX_CONTEXT_RATIO",
    "STATUS_BAR_CLOSE_TAG",
    "STATUS_BAR_OPEN_TAG",
    "TIMESTAMP_FORMAT",
    "ContextInvariantViolation",
    "InjectionStrategy",
    "StatusBarManager",
    "StatusBarRenderer",
    "StatusBarSectionProvider",
    "StatusBarState",
    "SystemEnvironment",
    "SystemInfoProvider",
    "TodoItem",
    "TodoPlanProvider",
    "TodoStatus",
    "ToolCallTracker",
    "ToolCounterState",
    "ToolStatsProvider",
    "detect_system_environment",
    "evaluate_injection_strategy",
    "format_timestamp",
    "is_status_bar_message",
    "prefix_with_timestamp",
    "safe_prune_status_bars",
]
