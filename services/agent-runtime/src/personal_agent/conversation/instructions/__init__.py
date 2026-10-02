"""conversation.instructions —— Markdown + XML 结构化提示词与人设装配中心。"""

from personal_agent.conversation.instructions.common import (
    COMMON_RULES,
    COMMON_RULES_BODY,
)
from personal_agent.conversation.instructions.compose import (
    build_persona_section_body,
    compose_instructions,
    compose_sectioned_prompt,
)
from personal_agent.conversation.instructions.executor import (
    EXECUTOR_INSTRUCTIONS,
    EXECUTOR_OUTPUT_CONTRACT,
    EXECUTOR_PREAMBLE,
    EXECUTOR_RULES,
    EXECUTOR_SECTIONS,
    EXECUTOR_WORKFLOW,
    create_executor_sectioned_prompt,
)
from personal_agent.conversation.instructions.planner import (
    PLANNER_INSTRUCTIONS,
    PLANNER_OUTPUT_CONTRACT,
    PLANNER_PREAMBLE,
    PLANNER_RULES,
    PLANNER_SECTIONS,
    PLANNER_WORKFLOW,
    create_planner_sectioned_prompt,
)

# 兼容既有命名的别名导出
INSTRUCTIONS = EXECUTOR_INSTRUCTIONS

__all__ = [
    "COMMON_RULES",
    "COMMON_RULES_BODY",
    "EXECUTOR_INSTRUCTIONS",
    "EXECUTOR_OUTPUT_CONTRACT",
    "EXECUTOR_PREAMBLE",
    "EXECUTOR_RULES",
    "EXECUTOR_SECTIONS",
    "EXECUTOR_WORKFLOW",
    "INSTRUCTIONS",
    "PLANNER_INSTRUCTIONS",
    "PLANNER_OUTPUT_CONTRACT",
    "PLANNER_PREAMBLE",
    "PLANNER_RULES",
    "PLANNER_SECTIONS",
    "PLANNER_WORKFLOW",
    "build_persona_section_body",
    "compose_instructions",
    "compose_sectioned_prompt",
    "create_executor_sectioned_prompt",
    "create_planner_sectioned_prompt",
]