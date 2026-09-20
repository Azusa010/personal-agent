"""shared 模块：对话与工作流共享的基础设施。"""

from personal_agent.shared.budget import (
    DEFAULT_MAX_STEPS,
    DEFAULT_MAX_TOOL_CALLS,
    Budget,
)
from personal_agent.shared.events import (
    EVENT_BUDGET_EXHAUSTED,
    EVENT_MODEL_USAGE,
    EVENT_REPLAN_COMPLETED,
    EVENT_REPLAN_REQUESTED,
    EVENT_STEP_COMPLETED,
    EVENT_STEP_STARTED,
    EVENT_TASK_COMPLETED,
    EVENT_TASK_FAILED,
    EVENT_TASK_STARTED,
    EVENT_TOOL_CALLED,
    EVENT_TOOL_RESULT,
    now_occurred_at,
)
from personal_agent.shared.host_channel import (
    HostChannel,
    HostChannelClosed,
    HostRequestFailed,
)
from personal_agent.shared.stream import (
    StreamEmitter,
    StreamSink,
    chunk_text,
    emit_thinking_chunks,
    event_notice,
    thinking_notice,
)

__all__ = [
    "DEFAULT_MAX_STEPS",
    "DEFAULT_MAX_TOOL_CALLS",
    "EVENT_BUDGET_EXHAUSTED",
    "EVENT_MODEL_USAGE",
    "EVENT_REPLAN_COMPLETED",
    "EVENT_REPLAN_REQUESTED",
    "EVENT_STEP_COMPLETED",
    "EVENT_STEP_STARTED",
    "EVENT_TASK_COMPLETED",
    "EVENT_TASK_FAILED",
    "EVENT_TASK_STARTED",
    "EVENT_TOOL_CALLED",
    "EVENT_TOOL_RESULT",
    "Budget",
    "HostChannel",
    "HostChannelClosed",
    "HostRequestFailed",
    "StreamEmitter",
    "StreamSink",
    "chunk_text",
    "emit_thinking_chunks",
    "event_notice",
    "now_occurred_at",
    "thinking_notice",
]