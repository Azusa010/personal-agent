from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

from personal_agent.context import ContextManager
from personal_agent.engine import (
    EVENT_MODEL_USAGE,
    EVENT_TASK_FAILED,  # noqa: F401
    EVENT_TASK_STARTED,  # noqa: F401
    AgentEngine,
    Budget,
    now_occurred_at,
)
from personal_agent.host_channel import HostChannel
from personal_agent.model_gateway import (
    ModelGateway,
    ModelUsage,  # noqa: F401
    UsageReporting,
)
from personal_agent.protocol.models import (
    PlanStepDto,
    ProfileDto,
    RunTaskCompleted,
    RunTaskEvent,
    RunTaskFailed,
    Turn,
)
from personal_agent.react_loop import (
    EVENT_STEP_COMPLETED,  # noqa: F401
    EVENT_STEP_STARTED,  # noqa: F401
    ReActLoop,
    ReActOutcome,  # noqa: F401
)
from personal_agent.stream import StreamSink


@runtime_checkable
class AgentStrategy(Protocol):
    """Agent 执行策略。

    三种实现：
    - ClassicStrategy：保持现有行为（Scripted 模式走这里）
    - ReActStrategy：纯 ReAct 循环（无预先计划指导）
    - PlanAndExecuteStrategy：逐步遍历计划，每步启动一个 ReAct 循环
    """

    def execute(
        self,
        model: ModelGateway,
        channel: HostChannel,
        goal: str,
        visible_capabilities: Sequence[str],
        plan: Sequence[PlanStepDto],
        history: Sequence[Turn],
        profile: ProfileDto | None,
        budget: Budget,
        stream: StreamSink | None,
    ) -> RunTaskCompleted | RunTaskFailed: ...


class ClassicStrategy:
    """保持现有的单循环行为，作为基准和 Scripted 模式兼容。"""

    def execute(
        self,
        model: ModelGateway,
        channel: HostChannel,
        goal: str,
        visible_capabilities: Sequence[str],
        plan: Sequence[PlanStepDto],
        history: Sequence[Turn],
        profile: ProfileDto | None,
        budget: Budget,
        stream: StreamSink | None,
    ) -> RunTaskCompleted | RunTaskFailed:
        context = ContextManager(plan=plan, history=history, profile=profile)
        engine = AgentEngine(
            model=model,
            channel=channel,
            context=context,
            budget=budget,
            stream=stream,
        )
        return engine.run(goal, visible_capabilities)


def _settle_usage(model: ModelGateway, events: list[RunTaskEvent]) -> None:
    if not isinstance(model, UsageReporting):
        return
    usage = model.usage_snapshot()
    if usage is None:
        return
    events.insert(
        max(len(events) - 1, 0),
        RunTaskEvent(
            type=EVENT_MODEL_USAGE,
            payload=usage.model_dump(),
            occurredAt=now_occurred_at(),
        ),
    )


class ReActStrategy:
    """纯 ReAct 循环（无预先计划指导）。"""

    def execute(
        self,
        model: ModelGateway,
        channel: HostChannel,
        goal: str,
        visible_capabilities: Sequence[str],
        plan: Sequence[PlanStepDto],
        history: Sequence[Turn],
        profile: ProfileDto | None,
        budget: Budget,
        stream: StreamSink | None,
    ) -> RunTaskCompleted | RunTaskFailed:
        context = ContextManager(plan=plan, history=history, profile=profile)
        loop = ReActLoop(
            model=model,
            channel=channel,
            context=context,
            budget=budget,
            stream=stream,
        )
        outcome = loop.run(goal, visible_capabilities, stop_on_step_complete=False)

        if outcome.kind in ("completed", "step_done"):
            res = RunTaskCompleted(
                status="completed",
                reply=outcome.reply or "",
                facts=outcome.facts or [],
                events=outcome.events,
            )
            _settle_usage(model, res.events)
            return res

        failed_res = RunTaskFailed(
            status="failed",
            reason=outcome.reason or "任务执行失败",
            events=outcome.events,
        )
        _settle_usage(model, failed_res.events)
        return failed_res


class PlanAndExecuteStrategy:
    """逐步遍历计划，每步启动一个 ReAct 循环。"""

    def execute(
        self,
        model: ModelGateway,
        channel: HostChannel,
        goal: str,
        visible_capabilities: Sequence[str],
        plan: Sequence[PlanStepDto],
        history: Sequence[Turn],
        profile: ProfileDto | None,
        budget: Budget,
        stream: StreamSink | None,
    ) -> RunTaskCompleted | RunTaskFailed:
        context = ContextManager(plan=plan, history=history, profile=profile)
        total_steps = 0
        total_tools = 0
        all_events: list[RunTaskEvent] = []
        last_reply = ""
        last_facts: list[dict[str, Any]] = []

        for idx, step in enumerate(plan):
            context.set_current_step(step)
            remaining_steps = max(budget.maxSteps - total_steps, 1)
            remaining_tools = max(budget.maxToolCalls - total_tools, 1)
            step_budget = Budget(maxSteps=remaining_steps, maxToolCalls=remaining_tools)

            loop = ReActLoop(
                model=model,
                channel=channel,
                context=context,
                budget=step_budget,
                stream=stream,
            )

            is_last = (idx == len(plan) - 1)
            step_goal = f"当前步骤目标：{step.description}\n总任务目标：{goal}"
            outcome = loop.run(
                step_goal,
                visible_capabilities,
                stop_on_step_complete=not is_last,
            )

            total_steps += outcome.steps_used
            total_tools += outcome.tool_calls_used
            all_events.extend(outcome.events)

            if outcome.kind == "completed":
                last_reply = outcome.reply or ""
                last_facts = outcome.facts or []
                break

            if outcome.kind == "step_done":
                last_reply = outcome.reply or ""
                continue

            failed_res = RunTaskFailed(
                status="failed",
                reason=outcome.reason or f"步骤 {idx + 1} 执行失败",
                events=all_events,
            )
            _settle_usage(model, failed_res.events)
            return failed_res

        completed_res = RunTaskCompleted(
            status="completed",
            reply=last_reply or "计划步骤已全部执行完成",
            facts=last_facts,
            events=all_events,
        )
        _settle_usage(model, completed_res.events)
        return completed_res
