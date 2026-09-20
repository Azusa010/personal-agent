"""shared/budget.py —— 执行步数与工具调用预算控制。"""

from pydantic import BaseModel, Field

DEFAULT_MAX_STEPS = 12
DEFAULT_MAX_TOOL_CALLS = 8


class Budget(BaseModel):
    """两维执行上限控制模型。"""

    maxSteps: int = Field(default=DEFAULT_MAX_STEPS, ge=1)
    maxToolCalls: int = Field(default=DEFAULT_MAX_TOOL_CALLS, ge=1)