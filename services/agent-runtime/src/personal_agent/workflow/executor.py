"""workflow/executor.py —— 确定性工作流执行器。

按声明好的 WorkflowStep 顺序执行底层能力调用，无需 LLM 决策。
向 HostChannel 发送 call_host 请求，并在事件流中产生与 Agent 相同的标准生命周期事件。
"""

import logging
from typing import Any

from personal_agent.protocol.models import (
    HostExecuteToolParams,
    RunTaskCompleted,
    RunTaskEvent,
    RunTaskFailed,
)
from personal_agent.shared import (
    EVENT_BUDGET_EXHAUSTED,
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
from personal_agent.workflow.definition import WorkflowDefinition, WorkflowState

log = logging.getLogger("personal_agent")


class WorkflowExecutor:
    """工作流执行引擎。"""

    def __init__(
        self,
        channel: HostChannel,
        budget: Budget | None = None,
        stream: StreamSink | None = None,
    ) -> None:
        self._channel = channel
        self._budget = budget if budget is not None else Budget()
        self._stream = stream

    def execute(
        self,
        workflow: WorkflowDefinition,
        inputs: dict[str, Any] | None = None,
    ) -> RunTaskCompleted | RunTaskFailed:
        state = WorkflowState(inputs=inputs or {})
        events: list[RunTaskEvent] = []
        self._emit(
            events,
            EVENT_TASK_STARTED,
            {"workflowId": workflow.id, "goal": workflow.name},
        )

        for step_idx, step in enumerate(workflow.steps):
            if (
                step_idx >= self._budget.maxSteps
                or step_idx >= self._budget.maxToolCalls
            ):
                reason = f"预算耗尽：已用 {step_idx} 步 / {step_idx} 次工具调用"
                self._emit(
                    events,
                    EVENT_BUDGET_EXHAUSTED,
                    {"steps": step_idx, "toolCalls": step_idx},
                )
                return self._fail(events, reason)

            # 1. 参数推导
            try:
                args = step.resolve_args(state)
            except Exception as e:
                log.exception("工作流步骤 [%s] 参数推导失败", step.id)
                return self._fail(events, f"步骤 [{step.id}] 参数推导失败: {e}")

            call_id = f"call-{step_idx + 1}"
            self._emit(
                events,
                EVENT_TOOL_CALLED,
                {
                    "callId": call_id,
                    "capability": step.capability,
                    "arguments": args,
                },
            )

            # 2. 调用底层 Host 能力
            try:
                result = self._channel.call_host(
                    HostExecuteToolParams(
                        callId=call_id,
                        capability=step.capability,
                        arguments=args,
                    )
                )
            except HostRequestFailed as e:
                return self._fail(events, str(e))
            except HostChannelClosed as e:
                return self._fail(events, f"RUNTIME_CHANNEL_CLOSED: {e}")

            self._emit(
                events,
                EVENT_TOOL_RESULT,
                {
                    "callId": call_id,
                    "capability": step.capability,
                    "ok": result.ok,
                },
            )

            payload = dict(result.model_extra or {})
            if not result.ok:
                err_code = payload.get("code", "TOOL_EXECUTION_FAILED")
                err_reason = payload.get("reason", f"步骤 [{step.id}] 执行失败")
                return self._fail(events, f"{err_code}: {err_reason}")

            # 步骤成功，产物入库供后续步骤引用
            state.set_result(step.id, payload)

        # 3. 产出汇总
        if workflow.produce_summary is not None:
            try:
                reply, facts = workflow.produce_summary(state)
            except Exception as e:  # noqa: BLE001
                return self._fail(events, f"工作流生成摘要失败: {e}")
        else:
            reply = f"工作流 [{workflow.name}] 执行完成"
            facts = []

        self._emit(
            events,
            EVENT_TASK_COMPLETED,
            {
                "reply": reply,
                "factCount": len(facts),
                "facts": [f.model_dump() for f in facts],
            },
        )

        return RunTaskCompleted(
            status="completed",
            reply=reply,
            facts=facts,
            events=events,
        )

    def _fail(self, events: list[RunTaskEvent], reason: str) -> RunTaskFailed:
        self._emit(events, EVENT_TASK_FAILED, {"reason": reason})
        return RunTaskFailed(status="failed", reason=reason, events=events)

    def _emit(
        self, events: list[RunTaskEvent], event_type: str, payload: dict[str, Any]
    ) -> None:
        event = RunTaskEvent(
            type=event_type, payload=payload, occurredAt=now_occurred_at()
        )
        events.append(event)
        if self._stream is not None:
            self._stream.event(event)
