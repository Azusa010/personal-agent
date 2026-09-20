"""shared/events.py —— 跨执行模式共享的事件常量与工具函数。"""

from datetime import UTC, datetime

EVENT_TASK_STARTED = "task_started"
EVENT_TOOL_CALLED = "tool_called"
EVENT_TOOL_RESULT = "tool_result"
EVENT_BUDGET_EXHAUSTED = "budget_exhausted"
EVENT_TASK_COMPLETED = "task_completed"
EVENT_TASK_FAILED = "task_failed"
EVENT_MODEL_USAGE = "model_usage"

# ReAct / PlanAndExecute 扩展事件
EVENT_STEP_STARTED = "step_started"
EVENT_STEP_COMPLETED = "step_completed"
EVENT_REPLAN_REQUESTED = "replan_requested"
EVENT_REPLAN_COMPLETED = "replan_completed"


def now_occurred_at() -> str:
    """RunTaskEvent.occurredAt 要求的格式：毫秒三位 + Z 结尾。

    datetime.now(UTC).isoformat() 给的是 +00:00 结尾、微秒六位，
    这里将其归一化为标准的 UTC 毫秒时间戳。
    """
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")