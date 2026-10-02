import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import ValidationError

from personal_agent.conversation.context import ContextManager
from personal_agent.conversation.loop.concurrency import execute_tool_calls_batched
from personal_agent.conversation.loop.engine import (
    CAPABILITY_NOT_REGISTERED,
    MODEL_CALL_FAILED,
)
from personal_agent.conversation.loop.fault_classifier import (
    FaultClassification,
    StreamStalledError,
    StreamWatchdog,
    classify_fault,
)
from personal_agent.conversation.loop.recovery import (
    RecoveryLevel,
    RecoveryPathBreaker,
    RecoveryPlan,
    determine_recovery_plan,
)
from personal_agent.conversation.loop.trajectory import (
    DeathSpiralError,
    DeathSpiralProtector,
    ToolFingerprintDetector,
)
from personal_agent.conversation.model.gateway import (
    BatchToolCallDecision,
    ModelCallFailed,
    ModelDecision,
    ModelGateway,
    Observation,
    ReplanDecision,
    ScriptExhausted,
    StepCompleteDecision,
    SummaryDecision,
    ToolCallDecision,
    ToolCallItem,
)
from personal_agent.conversation.sidecar import (
    RejectionCircuitBreaker,
    SidecarLlmClient,
    StreamBarrier,
    compact_and_persist_observation,
    evaluate_sidecar_gate,
)
from personal_agent.conversation.verification.summary import (
    EXTRACT_PDF_CAPABILITY,
    SummaryRejected,
    collect_retrieved_evidence,
    verify_summary,
)
from personal_agent.knowledge.agentic_search import (
    SEARCH_CAPABILITIES,
    QueryLoopDetector,
)
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    RunTaskEvent,
)
from personal_agent.shared import (
    EVENT_BUDGET_EXHAUSTED,
    EVENT_CIRCUIT_BREAKER_TRIPPED,
    EVENT_MODEL_USAGE,  # noqa: F401
    EVENT_SIDECAR_INSPECTED,
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
    fault: FaultClassification | None = None
    recovery_plan: RecoveryPlan | None = None


class ReActLoop:
    def __init__(
        self,
        model: ModelGateway,
        channel: HostChannel,
        context: ContextManager,
        budget: Budget,
        stream: StreamSink | None = None,
        loop_detector: QueryLoopDetector | None = None,
        sidecar_barrier: StreamBarrier | None = None,
        circuit_breaker: RejectionCircuitBreaker | None = None,
        sidecar_llm: SidecarLlmClient | None = None,
        watchdog: StreamWatchdog | None = None,
        path_breaker: RecoveryPathBreaker | None = None,
        is_background: bool = False,
        tool_detector: ToolFingerprintDetector | None = None,
        death_spiral_protector: DeathSpiralProtector | None = None,
    ) -> None:
        self._model = model
        self._channel = channel
        self._context = context
        self._budget = budget
        self._stream = stream
        self._loop_detector = loop_detector or QueryLoopDetector()
        self._tool_detector = tool_detector or ToolFingerprintDetector()
        self._death_spiral = death_spiral_protector or DeathSpiralProtector()
        self._barrier = sidecar_barrier
        self._circuit_breaker = circuit_breaker or (
            RejectionCircuitBreaker(task_id="default-task")
            if sidecar_barrier is not None
            else None
        )
        self._sidecar_llm = sidecar_llm
        self._watchdog = watchdog
        self._path_breaker = path_breaker or RecoveryPathBreaker()
        self._is_background = is_background

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
                reason = (
                    f"预算耗尽：已用 {steps_used} 步 / {tool_calls_used} 次工具调用"
                )
                self._emit(
                    events,
                    EVENT_BUDGET_EXHAUSTED,
                    {"steps": steps_used, "toolCalls": tool_calls_used},
                )
                self._emit(events, EVENT_TASK_FAILED, {"reason": reason})
                fault = classify_fault(reason)
                plan = determine_recovery_plan(
                    fault=fault,
                    breaker=self._path_breaker,
                    is_background=self._is_background,
                )
                return ReActOutcome(
                    kind="budget_exhausted",
                    reason=reason,
                    steps_used=steps_used,
                    tool_calls_used=tool_calls_used,
                    events=events,
                    fault=fault,
                    recovery_plan=plan,
                )

            try:
                decision = self._decide_with_recovery(goal, visible_capabilities)
            except DeathSpiralError as e:
                return self._fail(
                    events, str(e), steps_used, tool_calls_used, fault_source=e
                )
            except StreamStalledError as e:
                return self._fail(
                    events, str(e), steps_used, tool_calls_used, fault_source=e
                )
            except ScriptExhausted as e:
                return self._fail(
                    events, str(e), steps_used, tool_calls_used, fault_source=e
                )
            except ModelCallFailed as e:
                return self._fail(
                    events,
                    f"{MODEL_CALL_FAILED}: {e.reason}",
                    steps_used,
                    tool_calls_used,
                    fault_source=e,
                )

            steps_used += 1

            if isinstance(decision, ToolCallDecision):
                self._context.record_tool_call(decision)
                self._emit(
                    events,
                    EVENT_TOOL_CALLED,
                    {
                        "callId": decision.callId,
                        "capability": decision.capability,
                        "arguments": decision.arguments,
                    },
                )

                # 通用工具调用指纹检测：重复调用死循环拦截 (§2.2 B)
                is_duplicate, duplicate_warning = self._tool_detector.check_and_record(
                    decision.capability, decision.arguments
                )
                if is_duplicate:
                    synthetic_obs = Observation(
                        callId=decision.callId,
                        capability=decision.capability,
                        ok=False,
                        payload={
                            "warning": "duplicate_call",
                            "reason": duplicate_warning
                            or "连续多次发起相同工具调用，操作已陷入停滞，请更换参数或推进作答。",
                        },
                        arguments=decision.arguments,
                    )
                    self._emit(
                        events,
                        EVENT_TOOL_RESULT,
                        {
                            "callId": synthetic_obs.callId,
                            "capability": synthetic_obs.capability,
                            "ok": synthetic_obs.ok,
                        },
                    )
                    self._context.record(synthetic_obs)
                    tool_calls_used += 1
                    continue

                # 智能体化 RAG: 检索类能力连续死循环检测与反思拦截
                if decision.capability in SEARCH_CAPABILITIES:
                    query_arg = decision.arguments.get("query")
                    if isinstance(query_arg, str) and query_arg.strip():
                        is_loop, reflection = self._loop_detector.check_and_record(
                            decision.capability, query_arg
                        )
                        if is_loop:
                            synthetic_obs = Observation(
                                callId=decision.callId,
                                capability=decision.capability,
                                ok=False,
                                payload={
                                    "warning": "query_loop_detected",
                                    "reason": reflection
                                    or "连续多次发起高度相似检索，请更换关键词或推进作答。",
                                },
                                arguments=decision.arguments,
                            )
                            self._emit(
                                events,
                                EVENT_TOOL_RESULT,
                                {
                                    "callId": synthetic_obs.callId,
                                    "capability": synthetic_obs.capability,
                                    "ok": synthetic_obs.ok,
                                },
                            )
                            self._context.record(synthetic_obs)
                            tool_calls_used += 1
                            continue

                # Sidecar 独立安全审查门控
                if self._barrier is not None and self._circuit_breaker is not None:
                    assessment = self._barrier.wait_or_pass(
                        call_id=decision.callId,
                        capability=decision.capability,
                        arguments=decision.arguments,
                        goal=goal,
                    )
                    self._emit(
                        events,
                        EVENT_SIDECAR_INSPECTED,
                        assessment.model_dump(),
                    )
                    gate_result = evaluate_sidecar_gate(
                        assessment=assessment,
                        circuit_breaker=self._circuit_breaker,
                        sidecar_llm=self._sidecar_llm,
                        goal=goal,
                        capability=decision.capability,
                        arguments=decision.arguments,
                    )
                    if gate_result.tripped_event is not None:
                        self._emit(
                            events,
                            EVENT_CIRCUIT_BREAKER_TRIPPED,
                            gate_result.tripped_event.model_dump(),
                        )

                    if gate_result.action == "self_heal":
                        obs = gate_result.observation or Observation(
                            callId=decision.callId,
                            capability=decision.capability,
                            ok=False,
                            payload={
                                "error": "sidecar_rejection",
                                "reason": assessment.reason,
                            },
                            arguments=decision.arguments,
                        )
                        self._emit(
                            events,
                            EVENT_TOOL_RESULT,
                            {
                                "callId": obs.callId,
                                "capability": obs.capability,
                                "ok": obs.ok,
                            },
                        )
                        self._context.record(obs)
                        tool_calls_used += 1
                        continue
                    if gate_result.action == "halt":
                        return self._fail(
                            events,
                            gate_result.halt_reason or "Sidecar 安全门控终止任务",
                            steps_used,
                            tool_calls_used,
                        )

                try:
                    observation = self._execute(decision)
                    self._path_breaker.record_success("tool_self_heal")
                except HostRequestFailed as e:
                    if not self._death_spiral.enter():
                        ds_err = DeathSpiralError(
                            self._death_spiral.depth, self._death_spiral.max_depth
                        )
                        return self._fail(
                            events,
                            str(ds_err),
                            steps_used,
                            tool_calls_used,
                            fault_source=ds_err,
                        )
                    try:
                        fault = classify_fault(e)
                        plan = determine_recovery_plan(
                            fault=fault,
                            breaker=self._path_breaker,
                            is_background=self._is_background,
                        )
                        if (
                            plan.level == RecoveryLevel.LEVEL_2_DEGRADE
                            and plan.action == "feed_observation"
                        ):
                            log.warning(
                                "触发 Level 2 工具错误回灌自纠正：%s", plan.reason
                            )
                            observation = Observation(
                                callId=decision.callId,
                                capability=decision.capability,
                                ok=False,
                                payload={
                                    "error": "tool_execution_error",
                                    "reason": str(e),
                                },
                                arguments=decision.arguments,
                            )
                        else:
                            return self._fail(
                                events,
                                str(e),
                                steps_used,
                                tool_calls_used,
                                fault_source=e,
                                recovery_plan=plan,
                            )
                    finally:
                        self._death_spiral.exit()
                except HostChannelClosed as e:
                    return self._fail(
                        events,
                        f"RUNTIME_CHANNEL_CLOSED: {e}",
                        steps_used,
                        tool_calls_used,
                        fault_source=e,
                    )
                # Sidecar 超长工具输出动态压缩与本地临时文件落盘
                observation, raw_output_path = compact_and_persist_observation(
                    observation=observation,
                    sidecar_llm=self._sidecar_llm,
                )

                tool_result_payload = {
                    "callId": observation.callId,
                    "capability": observation.capability,
                    "ok": observation.ok,
                }
                if raw_output_path is not None:
                    tool_result_payload["rawOutputPath"] = str(raw_output_path)
                    tool_result_payload["compacted"] = True

                self._emit(
                    events,
                    EVENT_TOOL_RESULT,
                    tool_result_payload,
                )
                self._context.record(observation)
                tool_calls_used += 1

            elif isinstance(decision, BatchToolCallDecision):
                calls_to_execute: list[ToolCallItem] = []
                synth_obs_map: dict[str, Observation] = {}
                for call in decision.calls:
                    self._context.record_tool_call(call)
                    self._emit(
                        events,
                        EVENT_TOOL_CALLED,
                        {
                            "callId": call.callId,
                            "capability": call.capability,
                            "arguments": call.arguments,
                        },
                    )
                    #  工具批调用，指纹检测防止死循环
                    is_duplicate, duplicate_warning = (
                        self._tool_detector.check_and_record(
                            call.capability, call.arguments
                        )
                    )
                    if is_duplicate:
                        synth_obs_map[call.callId] = Observation(
                            callId=call.callId,
                            capability=call.capability,
                            ok=False,
                            payload={
                                "warning": "duplicate_call",
                                "reason": duplicate_warning
                                or "连续多次发起相同工具调用，操作已陷入停滞，请更换参数或推进作答。",
                            },
                            arguments=call.arguments,
                        )
                    else:
                        calls_to_execute.append(call)
                real_observations = (
                    execute_tool_calls_batched(
                        calls=calls_to_execute,
                        execute_single_fn=self._execute,
                    )
                    if calls_to_execute
                    else []
                )
                real_obs_map = {obs.callId: obs for obs in real_observations}
                for call in decision.calls:
                    obs = synth_obs_map.get(call.callId) or real_obs_map.get(
                        call.callId
                    )
                    if obs is None:
                        continue
                    observation, raw_output_path = compact_and_persist_observation(
                        observation=obs,
                        sidecar_llm=self._sidecar_llm,
                    )
                    tool_result_payload = {
                        "callId": observation.callId,
                        "capability": observation.capability,
                        "ok": observation.ok,
                    }
                    if raw_output_path is not None:
                        tool_result_payload["rawOutputPath"] = str(raw_output_path)
                        tool_result_payload["compacted"] = True
                    self._emit(
                        events,
                        EVENT_TOOL_RESULT,
                        tool_result_payload,
                    )
                    self._context.record(observation)
                tool_calls_used += len(decision.calls)
            elif isinstance(decision, SummaryDecision):
                try:
                    evidence = collect_retrieved_evidence(self._context.observations)
                    facts = verify_summary(
                        decision.facts,
                        evidence.pages,
                        require_page_refs=self._plan_requires_grounded_summary(),
                        evidence=evidence,
                    )
                except SummaryRejected as e:
                    return self._fail(
                        events, e.reason, steps_used, tool_calls_used, fault_source=e
                    )

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
                self._emit(
                    events,
                    EVENT_TASK_COMPLETED,
                    {"reply": decision.result, "factCount": 0, "facts": []},
                )
                return ReActOutcome(
                    kind="completed",
                    reply=decision.result,
                    facts=[],
                    steps_used=steps_used,
                    tool_calls_used=tool_calls_used,
                    events=events,
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
        fault_source: Any = None,
        recovery_plan: RecoveryPlan | None = None,
    ) -> ReActOutcome:
        self._emit(events, EVENT_TASK_FAILED, {"reason": reason})
        fault = classify_fault(fault_source if fault_source is not None else reason)
        plan = recovery_plan or getattr(self, "_last_recovery_plan", None)
        if plan is None:
            plan = determine_recovery_plan(
                fault=fault,
                breaker=self._path_breaker,
                is_background=self._is_background,
            )
        self._last_recovery_plan = None
        return ReActOutcome(
            kind="failed",
            reason=reason,
            steps_used=steps_used,
            tool_calls_used=tool_calls_used,
            events=events,
            fault=fault,
            recovery_plan=plan,
        )

    def _decide_with_recovery(
        self, goal: str, visible_capabilities: Sequence[str]
    ) -> ModelDecision:
        attempt = 1
        attempted_actions: list[str] = []
        while True:
            try:
                decision = self._decide(goal, visible_capabilities)
                self._path_breaker.record_success("silent_retry")
                return decision
            except (ModelCallFailed, StreamStalledError) as e:
                with self._death_spiral.guard():
                    fault = classify_fault(e)
                    plan = determine_recovery_plan(
                        fault=fault,
                        breaker=self._path_breaker,
                        attempt=attempt,
                        is_background=self._is_background,
                        attempted_actions=attempted_actions,
                    )
                    if plan.level == RecoveryLevel.LEVEL_1_RETRY:
                        log.warning(
                            "触发 Level 1 静默重试：%s，等待 %.2fs (第 %d 次尝试)",
                            plan.reason,
                            plan.delay_seconds,
                            attempt,
                        )
                        if plan.delay_seconds > 0:
                            time.sleep(plan.delay_seconds)
                        attempt += 1
                        attempted_actions = plan.attempted_actions
                        continue
                    if plan.level == RecoveryLevel.LEVEL_2_DEGRADE:
                        log.warning(
                            "触发 Level 2 降级调度：%s (action: %s)",
                            plan.reason,
                            plan.action,
                        )
                        if plan.action == "compact_context":
                            self._context._maxCharsPerString = max(
                                200, self._context._maxCharsPerString // 2
                            )
                            attempt += 1
                            attempted_actions = plan.attempted_actions
                            continue
                        elif plan.action == "continue_generation":
                            attempt += 1
                            attempted_actions = plan.attempted_actions
                            continue
                    # 无法静默重试（如已熔断或不可重试），暂存 plan 供 _fail 复用
                    self._last_recovery_plan = plan
                    raise

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

    def _execute(self, decision: ToolCallDecision | ToolCallItem) -> Observation:
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
        if self._watchdog is not None:
            self._watchdog.feed()
        if self._stream is None:
            decision = self._model.decide(context)
        else:
            thinking_sink = self._stream.thinking
            if self._watchdog is not None:
                thinking_sink = self._watchdog.wrap_sink(thinking_sink)
            decision = self._model.decide(context, thinking_sink)
        if self._watchdog is not None:
            self._watchdog.assert_alive()
            self._watchdog.feed()
        return decision

    def _plan_requires_grounded_summary(self) -> bool:
        """计划里有「提取 PDF」这一步，摘要就必须可溯源到页面。

        零工具或纯列表的轮次，结论来自工具观察而非页面文本——facts 允许为空、
        页码允许缺席；但只要给了页码，仍然必须真实（见 summary.verify_summary）。
        """
        return any(
            step.capability == EXTRACT_PDF_CAPABILITY for step in self._context.plan
        )
