"""shared/budget.py —— 执行步数与工具调用预算控制。"""
import os

from pydantic import BaseModel, Field

DEFAULT_MAX_STEPS = 50
DEFAULT_MAX_TOOL_CALLS = 40

def _get_int_env(name:str, default:int):
    raw = os.environ.get(name)
    if raw is None or len(raw) == 0:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value
max_steps = _get_int_env("PERSONAL_AGENT_MAX_STEPS", DEFAULT_MAX_STEPS)
max_tool_calls = _get_int_env("PERSONAL_AGENT_MAX_TOOL_CALLS", DEFAULT_MAX_TOOL_CALLS)


class Budget(BaseModel):
    """两维执行上限控制模型。

    预算的定位是**安全阀**（拦死循环、防烧钱），不是任务节奏管理器：
    默认值按「调研型任务也要跑得完」给足——多轮搜索加网页抓取 15-20 次
    调用很常见；Golden Path 只需 5 次，剩余全是余量。真想收紧或放开，
    用环境变量 PERSONAL_AGENT_MAX_STEPS / PERSONAL_AGENT_MAX_TOOL_CALLS。
    """

    maxSteps: int = Field(default=max_steps, ge=1)
    maxToolCalls: int = Field(default=max_tool_calls, ge=1)


def budget_exhausted_reason(steps_used: int, tool_calls_used: int, budget: Budget) -> str:
    """预算耗尽终态文案：带上真实上限，避免「已用 X 步」被误读成「上限是 X 步」。"""
    return (
        f"预算耗尽：已用 {steps_used}/{budget.maxSteps} 步、"
        f"{tool_calls_used}/{budget.maxToolCalls} 次工具调用"
    )