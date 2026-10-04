"""shared/budget.py —— 执行步数与工具调用预算控制。"""
import os

from pydantic import BaseModel, Field

DEFAULT_MAX_STEPS = 12
DEFAULT_MAX_TOOL_CALLS = 8

def _get_int_env(name:str, default:int):
    raw = os.environ.get(name)
    if raw is None or len(raw) == 0:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value
max_tool_calls = _get_int_env("PERSONAL_AGENT_MAX_TOOL_CALLS", DEFAULT_MAX_TOOL_CALLS)


class Budget(BaseModel):
    """两维执行上限控制模型。"""

    maxSteps: int = Field(default=DEFAULT_MAX_STEPS, ge=1)
    maxToolCalls: int = Field(default=max_tool_calls, ge=1)