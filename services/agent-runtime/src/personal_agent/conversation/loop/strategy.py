from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.loop.engine import AgentEngine
from personal_agent.conversation.loop.react_loop import (
    EVENT_REPLAN_COMPLETED,
    EVENT_REPLAN_REQUESTED,
    EVENT_STEP_COMPLETED,  # noqa: F401
    EVENT_STEP_STARTED,  # noqa: F401
    ReActLoop,
    ReActOutcome,  # noqa: F401
)
from personal_agent.conversation.model.gateway import (
    ModelGateway,
    ModelUsage,  # noqa: F401
    UsageReporting,
)
from personal_agent.planner import Planner
from personal_agent.protocol.models import (
    PlanStepDto,
    ProfileDto,
    RunTaskCompleted,
    RunTaskEvent,
    RunTaskFailed,
    Turn,
)
from personal_agent.shared import (
    EVENT_MODEL_USAGE,
    EVENT_TASK_FAILED,  # noqa: F401
    EVENT_TASK_STARTED,  # noqa: F401
    Budget,
    HostChannel,
    StreamSink,
    now_occurred_at,
)


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
        planner: Planner | None = None,
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
        planner: Planner | None = None,
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
        planner: Planner | None = None,
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
    """逐步遍历计划，每步启动一个 ReAct 循环。支持动态 Re-planning。"""

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
        planner: Planner | None = None,
    ) -> RunTaskCompleted | RunTaskFailed:
        context = ContextManager(plan=plan, history=history, profile=profile)
        total_steps = 0
        total_tools = 0
        all_events: list[RunTaskEvent] = []
        last_reply = ""
        last_facts: list[dict[str, Any]] = []

        completed_steps: list[PlanStepDto] = []
        remaining_steps: list[PlanStepDto] = list(plan)
        replan_count = 0
        max_replans = 2

        while remaining_steps:
            step = remaining_steps.pop(0)
            context.set_current_step(step)

            remaining_steps_budget = max(budget.maxSteps - total_steps, 1)
            remaining_tools_budget = max(budget.maxToolCalls - total_tools, 1)
            step_budget = Budget(
                maxSteps=remaining_steps_budget, maxToolCalls=remaining_tools_budget
            )

            loop = ReActLoop(
                model=model,
                channel=channel,
                context=context,
                budget=step_budget,
                stream=stream,
            )

            is_last = len(remaining_steps) == 0
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
                completed_steps.append(step)
                last_reply = outcome.reply or ""
                last_facts = outcome.facts or []
                break

            if outcome.kind == "step_done":
                completed_steps.append(step)
                last_reply = outcome.reply or ""
                continue

            if outcome.kind == "replan":
                if replan_count >= max_replans:
                    failed_res = RunTaskFailed(
                        status="failed",
                        reason=f"达到最大重规划次数上限 ({max_replans})，终止任务: {outcome.reason}",
                        events=all_events,
                    )
                    _settle_usage(model, failed_res.events)
                    return failed_res

                if planner is None:
                    failed_res = RunTaskFailed(
                        status="failed",
                        reason=f"模型请求重规划但未提供 Planner: {outcome.reason}",
                        events=all_events,
                    )
                    _settle_usage(model, failed_res.events)
                    return failed_res

                replan_count += 1
                req_event = RunTaskEvent(
                    type=EVENT_REPLAN_REQUESTED,
                    payload={
                        "reason": outcome.reason,
                        "stepIndex": len(completed_steps),
                        "replanCount": replan_count,
                    },
                    occurredAt=now_occurred_at(),
                )
                all_events.append(req_event)
                if stream is not None:
                    stream.event(req_event)

                completed_summary = "; ".join(
                    f"步骤 {i+1} ({s.description}) 已完成"
                    for i, s in enumerate(completed_steps)
                )
                replan_prompt = (
                    f"原任务目标：{goal}\n"
                    f"已完成进度：{completed_summary or '尚未完成任何步骤'}\n"
                    f"重规划原因：{outcome.reason}\n"
                    f"请根据当前状态规划完成目标的后续步骤。"
                )
                try:
                    new_steps_raw = planner.plan(
                        goal=replan_prompt,
                        visibleCapabilities=visible_capabilities,
                        history=history,
                        profile=profile,
                    )
                except Exception as e:  # noqa: BLE001
                    failed_res = RunTaskFailed(
                        status="failed",
                        reason=f"执行重新规划失败: {e}",
                        events=all_events,
                    )
                    _settle_usage(model, failed_res.events)
                    return failed_res

                new_remaining = [
                    PlanStepDto(description=s.description, capability=s.capability)
                    for s in new_steps_raw
                ]
                full_plan = list(completed_steps) + new_remaining
                context.update_plan(full_plan)

                comp_event = RunTaskEvent(
                    type=EVENT_REPLAN_COMPLETED,
                    payload={
                        "reason": outcome.reason,
                        "newPlan": [
                            s.model_dump(exclude_none=True) for s in full_plan
                        ],
                        "remainingSteps": [
                            s.model_dump(exclude_none=True) for s in new_remaining
                        ],
                        "version": replan_count + 1,
                    },
                    occurredAt=now_occurred_at(),
                )
                all_events.append(comp_event)
                if stream is not None:
                    stream.event(comp_event)

                remaining_steps = new_remaining
                continue

            # outcome.kind in ("failed", "budget_exhausted")
            failed_res = RunTaskFailed(
                status="failed",
                reason=outcome.reason or f"步骤 {len(completed_steps) + 1} 执行失败",
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
