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
    ModelCallFailed,
    ModelDecision,
    ModelGateway,
    Observation,
    ScriptExhausted,
    SummaryDecision,
    ToolCallDecision,
    UsageReporting,
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
# 模型用量结算（TASK-027）。只有会记账的网关（LiveModel）才会产生这条；
# 它落在终态事件之前，时间线上是「先记花了多少，再宣布结局」。
EVENT_MODEL_USAGE = "model_usage"


CAPABILITY_NOT_REGISTERED = "CAPABILITY_NOT_REGISTERED"

# 模型侧失败的 reason 前缀。与 RUNTIME_MODEL_NOT_CONFIGURED 分开：
# 那个是「进程压根没配模型」，这个是「配了但这次调用没成」。
MODEL_CALL_FAILED = "MODEL_CALL_FAILED"


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
        outcome = self._drive(goal, visibleCapabilities)
        self._settle_usage(outcome)
        return outcome

    def _drive(
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
            except ModelCallFailed as e:
                # 模型这一侧的问题（网络、鉴权、结构化输出不合契约）是任务的失败原因，
                # 不是运行时内部错误：带上前缀回传，任务记录里直接看得出是哪一侧。
                return self._fail(events, f"{MODEL_CALL_FAILED}: {e.reason}")
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

    def _settle_usage(self, outcome: RunTaskCompleted | RunTaskFailed) -> None:
        """收尾结算：向会记账的网关要一次用量，插成终态事件前的一条 model_usage。

        插在倒数第一条之前而不是直接追加：时间线上先有「这次花了多少」，
        再由 task_completed / task_failed 宣布结局，倒过来读着像结算发生在结局之后。
        失败的任务也结算——账要按次数记，跑崩的那次同样花了 token。
        ScriptedModel 不实现 UsageReporting，这里一条都不加，
        Golden Path E2E 钉的事件类型序列因此不受影响。
        """
        if not isinstance(self._model, UsageReporting):
            return
        usage = self._model.usage_snapshot()
        if usage is None:
            return
        outcome.events.insert(
            max(len(outcome.events) - 1, 0),
            RunTaskEvent(
                type=EVENT_MODEL_USAGE,
                payload=usage.model_dump(),
                occurredAt=now_occurred_at(),
            ),
        )

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

