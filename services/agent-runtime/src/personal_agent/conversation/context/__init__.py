"""conversation.context —— 对话上下文截断、观察管理与状态构建。"""

from personal_agent.conversation.context.manager import (
    DEFAULT_MAX_CHARS_PER_STRING,
    TRUNCATION_MARKER,
    ContextManager,
    truncate_strings,
)

__all__ = [
    "DEFAULT_MAX_CHARS_PER_STRING",
    "TRUNCATION_MARKER",
    "ContextManager",
    "truncate_strings",
]