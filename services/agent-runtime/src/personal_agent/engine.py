"""AgentEngine —— 最小 Agent Loop 与预算控制。

一个 engine 只跑一个任务：ContextManager 持有 observations，跨任务复用会把
上一个任务的观察串进来。
run() 是同步阻塞的：engine 跑的时候 runtime 主循环停在 handle_line 里，
stdin 由 HostChannel.call_host 独占读，非匹配行塞 inbox。
"""

import logging
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from personal_agent.context import ContextManager
from personal_agent.host_channel import (
    HostChannel,
    HostChannelClosed,
    HostRequestFailed,
)
from personal_agent.model_gateway import (
    ModelDecision,
    ModelGateway,
    Observation,
    ScriptExhausted,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    RunTaskCompleted,
    RunTaskEvent,
    RunTaskFailed,
)
from personal_agent.summary import (
    SummaryRejected,
    collect_extracted_pages,
    verify_summary,
)

log = logging.getLogger("personal_agent")

DEFAULT_MAX_STEPS = 8
DEFAULT_MAX_TOOL_CALLS = 5


EVENT_TASK_STARTED = "task_started"
EVENT_TOOL_CALLED = "tool_called"
EVENT_TOOL_RESULT = "tool_result"
EVENT_BUDGET_EXHAUSTED = "budget_exhausted"
EVENT_TASK_COMPLETED = "task_completed"
EVENT_TASK_FAILED = "task_failed"


CAPABILITY_NOT_REGISTERED = "CAPABILITY_NOT_REGISTERED"


def now_occurred_at() -> str:
    """RunTaskEvent.occurredAt 要求的格式：毫秒三位 + Z 结尾。

    datetime.now(UTC).isoformat() 给的是 +00:00 结尾、微秒六位
    """
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Budget(BaseModel):
    """
    两维上限。只是配置，计数在 run() 的局部变量里。
    """

    maxSteps: int = Field(default=DEFAULT_MAX_STEPS, ge=1)
    maxToolCalls: int = Field(default=DEFAULT_MAX_TOOL_CALLS, ge=1)


class AgentEngine:
    def __init__(
        self,
        model: ModelGateway,
        channel: HostChannel,
        context: ContextManager,
        budget: Budget | None = None,
    ) -> None:
        self._model = model
        self._channel = channel
        self._context = context
        self._budget = budget if budget is not None else Budget()

    def run(
        self, goal: str, visibleCapabilities: Sequence[str]
    ) -> RunTaskCompleted | RunTaskFailed:
        events: list[RunTaskEvent] = []
        self._emit(events, EVENT_TASK_STARTED, {"goal": goal})
        steps: int = 0
        toolCalls: int = 0
        while True:
            if self._budget_exceeded(steps, toolCalls):
                self._emit(
                    events,
                    EVENT_BUDGET_EXHAUSTED,
                    {"steps": steps, "toolCalls": toolCalls},
                )
                return self._fail(
                    events, f"预算耗尽：已用 {steps} 步 / {toolCalls} 次工具调用"
                )
            try:
                decision = self._decide(goal, visibleCapabilities)
            except ScriptExhausted as e:
                return self._fail(events, str(e))
            steps += 1
            if isinstance(decision, SummaryDecision):
                try:
                    facts = verify_summary(
                        decision.facts,
                        collect_extracted_pages(self._context.observations),
                    )
                except SummaryRejected as e:
                    return self._fail(events, e.reason)
                self._emit(events, EVENT_TASK_COMPLETED, {"factCount": len(facts),"facts": facts})
                return RunTaskCompleted(status="completed", facts=facts, events=events)
            self._emit(
                events,
                EVENT_TOOL_CALLED,
                {
                    "callId": decision.callId,
                    "capability": decision.capability,
                    "arguments": decision.arguments,
                },
            )
            try:
                observation = self._execute(decision)
            except HostRequestFailed as e:
                return self._fail(events, str(e))
            except HostChannelClosed as e:
                return self._fail(events, f"RUNTIME_CHANNEL_CLOSED: {e}")
            self._emit(
                events,
                EVENT_TOOL_RESULT,
                {
                    "callId": observation.callId,
                    "capability": observation.capability,
                    "ok": observation.ok,
                },
            )
            self._context.record(observation)
            toolCalls += 1

    def _fail(self, events: list[RunTaskEvent], reason: str) -> RunTaskFailed:
        """失败路径统一走这里，保证 events 一定跟着回传。"""
        self._emit(events, EVENT_TASK_FAILED, {"reason": reason})
        return RunTaskFailed(status="failed", reason=reason, events=events)

    def _emit(
        self, events: list[RunTaskEvent], event_type: str, payload: dict[str, Any]
    ) -> None:
        """事件构造集中在这一个地方，run() 里不要直接 new RunTaskEvent。"""
        events.append(
            RunTaskEvent(type=event_type, payload=payload, occurredAt=now_occurred_at())
        )

    def _budget_exceeded(self, steps: int, toolCalls: int) -> bool:
        return steps >= self._budget.maxSteps or toolCalls >= self._budget.maxToolCalls

    def _decide(self, goal: str, visibleCapabilities: Sequence[str]) -> ModelDecision:
        return self._model.decide(self._context.build(goal, visibleCapabilities))

    def _execute(self, decision: ToolCallDecision) -> Observation:
        """执行一次工具调用。capability 不在协议枚举内时就地造 Observation，
        其余情况一律透传 host 的 ok 与 model_extra。"""
        try:
            params = HostExecuteToolParams(
                callId=decision.callId,
                capability=decision.capability,
                arguments=decision.arguments,
            )
        except ValidationError:
            log.warning("模型请求了协议枚举外的 capability: %s", decision.capability)
            return Observation(
                callId=decision.callId,
                capability=decision.capability,
                ok=False,
                payload={
                    "code": CAPABILITY_NOT_REGISTERED,
                    "reason": f"capability {decision.capability} 不在协议枚举内",
                },
            )
        result = self._channel.call_host(params)
        return Observation(
            callId=decision.callId,
            capability=decision.capability,
            ok=result.ok,
            payload=dict(result.model_extra or {}),
        )

