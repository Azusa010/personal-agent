import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import ValidationError

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.loop.engine import (
    CAPABILITY_NOT_REGISTERED,
    MODEL_CALL_FAILED,
)
from personal_agent.conversation.model.gateway import (
    ModelCallFailed,
    ModelDecision,
    ModelGateway,
    Observation,
    ReplanDecision,
    ScriptExhausted,
    StepCompleteDecision,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.conversation.verification.summary import (
    EXTRACT_PDF_CAPABILITY,
    SummaryRejected,
    collect_extracted_pages,
    verify_summary,
)
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    RunTaskEvent,
)
from personal_agent.shared import (
    EVENT_BUDGET_EXHAUSTED,
    EVENT_MODEL_USAGE,  # noqa: F401
    EVENT_TASK_COMPLETED,
    EVENT_TASK_FAILED,
    EVENT_TASK_STARTED,
    EVENT_TOOL_CALLED,
    EVENT_TOOL_RESULT,
    Budget,
    HostChannel,
    HostChannelClosed,
    HostRequestFailed,
    StreamSink,
    now_occurred_at,
)

log = logging.getLogger("personal_agent")

EVENT_STEP_STARTED = "step_started"
EVENT_STEP_COMPLETED = "step_completed"
EVENT_REPLAN_REQUESTED = "replan_requested"
EVENT_REPLAN_COMPLETED = "replan_completed"


@dataclass
class ReActOutcome:
    """ReAct 循环的退出结果。不上协议，纯 Python 内部类型。"""

    kind: Literal["completed", "step_done", "replan", "budget_exhausted", "failed"]
    reply: str | None = None
    facts: list[dict[str, Any]] | None = None
    reason: str | None = None
    steps_used: int = 0
    tool_calls_used: int = 0
    events: list[RunTaskEvent] = field(default_factory=list)


class ReActLoop:
    def __init__(
        self,
        model: ModelGateway,
        channel: HostChannel,
        context: ContextManager,
        budget: Budget,
        stream: StreamSink | None = None,
    ) -> None:
        self._model = model
        self._channel = channel
        self._context = context
        self._budget = budget
        self._stream = stream

    def run(
        self,
        goal: str,
        visible_capabilities: Sequence[str],
        stop_on_step_complete: bool = False,
    ) -> ReActOutcome:
        """运行单步或完整的 ReAct 循环。
        # Contract:
        #   - Input: goal string, visible capabilities list, stop_on_step_complete flag
        #   - Output: ReActOutcome 记录最终状态与花费的预算及收集的事件
        #   - Invariants: 每次模型决策前必须检查预算; 决策后若是工具必须执行并写入上下文。
        #   - Boundary conditions: 循环步数或工具调用数达到预算上限触发 budget_exhausted。
        #   - Error codes: MODEL_CALL_FAILED, RUNTIME_CHANNEL_CLOSED (在 reason 中携带)
        #   - Test file: tests/test_react_loop.py
        """
        steps_used: int = 0
        tool_calls_used: int = 0
        events: list[RunTaskEvent] = []
        self._emit(events, EVENT_TASK_STARTED, {"goal": goal})

        while True:
            if (
                steps_used >= self._budget.maxSteps
                or tool_calls_used >= self._budget.maxToolCalls
            ):
                reason = f"预算耗尽：已用 {steps_used} 步 / {tool_calls_used} 次工具调用"
                self._emit(
                    events,
                    EVENT_BUDGET_EXHAUSTED,
                    {"steps": steps_used, "toolCalls": tool_calls_used},
                )
                self._emit(events, EVENT_TASK_FAILED, {"reason": reason})
                return ReActOutcome(
                    kind="budget_exhausted",
                    reason=reason,
                    steps_used=steps_used,
                    tool_calls_used=tool_calls_used,
                    events=events,
                )

            try:
                decision = self._decide(goal, visible_capabilities)
            except ScriptExhausted as e:
                return self._fail(events, str(e), steps_used, tool_calls_used)
            except ModelCallFailed as e:
                return self._fail(
                    events, f"{MODEL_CALL_FAILED}: {e.reason}", steps_used, tool_calls_used
                )

            steps_used += 1

            if isinstance(decision, ToolCallDecision):
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
                    return self._fail(events, str(e), steps_used, tool_calls_used)
                except HostChannelClosed as e:
                    return self._fail(
                        events,
                        f"RUNTIME_CHANNEL_CLOSED: {e}",
                        steps_used,
                        tool_calls_used,
                    )
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
                tool_calls_used += 1

            elif isinstance(decision, SummaryDecision):
                try:
                    facts = verify_summary(
                        decision.facts,
                        collect_extracted_pages(self._context.observations),
                        require_page_refs=self._plan_requires_grounded_summary(),
                    )
                except SummaryRejected as e:
                    return self._fail(events, e.reason, steps_used, tool_calls_used)

                self._emit(
                    events,
                    EVENT_TASK_COMPLETED,
                    {
                        "reply": decision.reply,
                        "factCount": len(facts),
                        "facts": [f.model_dump() for f in facts],
                    },
                )
                return ReActOutcome(
                    kind="completed",
                    reply=decision.reply,
                    facts=[f.model_dump() for f in facts],
                    steps_used=steps_used,
                    tool_calls_used=tool_calls_used,
                    events=events,
                )

            elif isinstance(decision, StepCompleteDecision):
                if stop_on_step_complete:
                    self._emit(
                        events,
                        EVENT_STEP_COMPLETED,
                        {"result": decision.result},
                    )
                    return ReActOutcome(
                        kind="step_done",
                        reply=decision.result,
                        steps_used=steps_used,
                        tool_calls_used=tool_calls_used,
                        events=events,
                    )
                return self._fail(
                    events,
                    "模型请求推进到下一步，但当前不是步骤执行模式",
                    steps_used,
                    tool_calls_used,
                )

            elif isinstance(decision, ReplanDecision):
                return ReActOutcome(
                    kind="replan",
                    reason=decision.reason,
                    steps_used=steps_used,
                    tool_calls_used=tool_calls_used,
                    events=events,
                )

            else:
                return self._fail(
                    events,
                    f"未知的模型决策类型: {type(decision)}",
                    steps_used,
                    tool_calls_used,
                )

    def _fail(
        self,
        events: list[RunTaskEvent],
        reason: str,
        steps_used: int,
        tool_calls_used: int,
    ) -> ReActOutcome:
        self._emit(events, EVENT_TASK_FAILED, {"reason": reason})
        return ReActOutcome(
            kind="failed",
            reason=reason,
            steps_used=steps_used,
            tool_calls_used=tool_calls_used,
            events=events,
        )



    def _emit(
        self, events: list[RunTaskEvent], event_type: str, payload: dict[str, Any]
    ) -> None:
        """事件构造集中在这一个地方，run() 里不要直接 new RunTaskEvent。"""
        event = RunTaskEvent(
            type=event_type, payload=payload, occurredAt=now_occurred_at()
        )
        events.append(event)
        if self._stream is not None:
            self._stream.event(event)

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
                arguments=decision.arguments,
            )
        result = self._channel.call_host(params)
        return Observation(
            callId=decision.callId,
            capability=decision.capability,
            ok=result.ok,
            payload=dict(result.model_extra or {}),
            arguments=decision.arguments,
        )

    def _decide(self, goal: str, visible_capabilities: Sequence[str]) -> ModelDecision:
        context = self._context.build(goal, visible_capabilities)
        if self._stream is None:
            return self._model.decide(context)
        return self._model.decide(context, self._stream.thinking)

    def _plan_requires_grounded_summary(self) -> bool:
        """计划里有「提取 PDF」这一步，摘要就必须可溯源到页面。

        零工具或纯列表的轮次，结论来自工具观察而非页面文本——facts 允许为空、
        页码允许缺席；但只要给了页码，仍然必须真实（见 summary.verify_summary）。
        """
        return any(
            step.capability == EXTRACT_PDF_CAPABILITY for step in self._context.plan
        )
