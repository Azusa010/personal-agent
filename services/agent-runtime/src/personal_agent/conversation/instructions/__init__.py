"""conversation.instructions —— Markdown + XML 结构化提示词与人设装配中心。"""

from personal_agent.conversation.instructions.compose import compose_instructions
from personal_agent.conversation.instructions.executor import EXECUTOR_INSTRUCTIONS
from personal_agent.conversation.instructions.planner import PLANNER_INSTRUCTIONS

# 兼容既有命名的别名导出
INSTRUCTIONS = EXECUTOR_INSTRUCTIONS

__all__ = [
    "EXECUTOR_INSTRUCTIONS",
    "INSTRUCTIONS",
    "PLANNER_INSTRUCTIONS",
    "compose_instructions",
]