"""conversation.context —— 对话上下文截断、观察管理与状态构建。"""

from personal_agent.conversation.context.manager import (
    DEFAULT_MAX_CHARS_PER_STRING,
    TRUNCATABLE_KEYS,
    TRUNCATION_MARKER,
    ContextManager,
    truncate_strings,
)
from personal_agent.conversation.context.sectioned_prompt import (
    DEFAULT_SECTION_ORDER,
    SectionedSystemPrompt,
)

__all__ = [
    "DEFAULT_MAX_CHARS_PER_STRING",
    "DEFAULT_SECTION_ORDER",
    "TRUNCATABLE_KEYS",
    "TRUNCATION_MARKER",
    "ContextManager",
    "SectionedSystemPrompt",
    "truncate_strings",
]