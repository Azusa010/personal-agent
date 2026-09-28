"""AgentStrategy 策略测试。

覆盖：
1. ClassicStrategy、ReActStrategy、PlanAndExecuteStrategy 均实现 AgentStrategy 契约
2. ClassicStrategy 保留已有 engine 确定性逻辑
3. resolve_strategy 环境分流判定
4. ReActStrategy 与 PlanAndExecuteStrategy 的运行流程
"""



from unittest.mock import MagicMock

from personal_agent.conversation.sidecar import (
    RejectionCircuitBreaker,
    StreamBarrier,
)
from personal_agent.engine import Budget
from personal_agent.model_gateway import (
    StepCompleteDecision,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.protocol.models import (
    CapabilityDescriptor,
    HostExecuteToolParams,
    HostExecuteToolResult,
    PlanStepDto,
    Request,
    RunTaskCompleted,
    RunTaskFailed,
    RunTaskParams,
    SidecarAssessment,
)
from personal_agent.runtime import (
    SCRIPT_ENV,
    STRATEGY_ENV,
    RuntimeDeps,
    handle_run_task,
    resolve_strategy,
)
from personal_agent.scripted_model import ScriptedModel
from personal_agent.strategy import (
    AgentStrategy,
    ClassicStrategy,
    PlanAndExecuteStrategy,
    ReActStrategy,
)

VISIBLE = ["filesystem_list", "document_extract_pdf"]


class FakeChannel:
    def __init__(self, results):
        self._results = list(results)
        self.calls = []

    def call_host(self, params: HostExecuteToolParams):
        self.calls.append(params)
        if not self._results:
            raise AssertionError("FakeChannel 预设结果已用尽")
        item = self._results.pop(0)
        if isinstance(item, Exception):
            raise item
        return HostExecuteToolResult.model_validate(item)


def list_result():
    return {
        "ok": True,
        "entries": [
            {
                "name": "a.pdf",
                "absolutePath": "D:/downloads/a.pdf",
                "modifiedAt": "2026-09-01T00:00:00Z",
                "sizeBytes": 2048,
            }
        ],
    }


def test_strategies_implement_agent_strategy_protocol():
    """三大策略必须都满足 AgentStrategy 接口契约。"""
    assert isinstance(ClassicStrategy(), AgentStrategy)
    assert isinstance(ReActStrategy(), AgentStrategy)
    assert isinstance(PlanAndExecuteStrategy(), AgentStrategy)


def test_resolve_strategy_env_routing(monkeypatch):
    """验证 resolve_strategy 的环境变量解析优先级。"""
    # 1. 剧本优先 -> ClassicStrategy
    monkeypatch.setenv(SCRIPT_ENV, "path/to/script.json")
    monkeypatch.setenv(STRATEGY_ENV, "react")
    assert isinstance(resolve_strategy(), ClassicStrategy)

    # 2. 无剧本 + STRATEGY_ENV=react -> ReActStrategy
    monkeypatch.delenv(SCRIPT_ENV, raising=False)
    monkeypatch.setenv(STRATEGY_ENV, "react")
    assert isinstance(resolve_strategy(), ReActStrategy)

    # 3. 无剧本 + STRATEGY_ENV=plan_execute -> PlanAndExecuteStrategy
    monkeypatch.setenv(STRATEGY_ENV, "plan_execute")
    assert isinstance(resolve_strategy(), PlanAndExecuteStrategy)

    # 4. 默认无配置 -> PlanAndExecuteStrategy
    monkeypatch.delenv(STRATEGY_ENV, raising=False)
    assert isinstance(resolve_strategy(), PlanAndExecuteStrategy)


def test_classic_strategy_executes_golden_path():
    """ClassicStrategy 必须完美无损地跑通 Golden Path 任务。"""
    strategy = ClassicStrategy()
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(
            kind="summary",
            reply="扫描完毕",
            facts=[],
        ),
    ]
    model = ScriptedModel(decisions)
    channel = FakeChannel([list_result()])
    plan = [
        PlanStepDto(description="列出文件", capability="filesystem_list"),
        PlanStepDto(description="直接总结"),
    ]

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="扫描文件",
        visible_capabilities=VISIBLE,
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(),
        stream=None,
    )

    assert isinstance(result, RunTaskCompleted)
    assert result.status == "completed"
    assert result.reply == "扫描完毕"


def test_react_strategy_wires_sidecar_components():
    """ReActStrategy 必须将 sidecar 组件传递给 ReActLoop 并产出 sidecar_inspected 事件。"""
    strategy = ReActStrategy()
    mock_classifier = MagicMock()
    mock_classifier.classify.return_value = SidecarAssessment(
        callId="c-1",
        capability="filesystem_list",
        verdict="ALLOW",
        reason="安全通过",
        assessedBy="mock-classifier",
        occurredAt="2026-09-28T00:00:00.000Z",
    )
    barrier = StreamBarrier(classifier=mock_classifier)
    cb = RejectionCircuitBreaker(task_id="task-react-sidecar", threshold=3)

    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-1",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(
            kind="summary",
            reply="扫描完毕",
            facts=[],
        ),
    ]
    model = ScriptedModel(decisions)
    channel = FakeChannel([list_result()])
    plan = [
        PlanStepDto(description="列出文件", capability="filesystem_list"),
        PlanStepDto(description="直接总结"),
    ]

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="扫描文件",
        visible_capabilities=VISIBLE,
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(),
        stream=None,
        sidecar_barrier=barrier,
        circuit_breaker=cb,
    )
    barrier.close()

    assert isinstance(result, RunTaskCompleted)
    assert result.status == "completed"
    event_types = [e.type for e in result.events]
    assert "sidecar_inspected" in event_types
    assert cb.consecutive_rejections == 0


def test_plan_and_execute_strategy_shares_single_circuit_breaker_across_steps():
    """PlanAndExecuteStrategy 跨步骤执行时必须共享同一个 circuit_breaker 实例。"""
    strategy = PlanAndExecuteStrategy()
    mock_classifier = MagicMock()
    mock_classifier.classify.side_effect = [
        # 第一步：第一次拦截，触发 self_heal 自愈
        SidecarAssessment(
            callId="c-bad",
            capability="filesystem_list",
            verdict="REJECT_WITH_FEEDBACK",
            riskCategory="SCOPE_ESCAPING",
            reason="第一步越界",
            remediation="请限定范围",
            assessedBy="mock-classifier",
            occurredAt="2026-09-28T00:00:00.000Z",
        ),
        # 第一步：自愈重试放行
        SidecarAssessment(
            callId="c-good-1",
            capability="filesystem_list",
            verdict="ALLOW",
            reason="放行",
            assessedBy="mock-classifier",
            occurredAt="2026-09-28T00:00:00.000Z",
        ),
        # 第二步：放行
        SidecarAssessment(
            callId="c-good-2",
            capability="filesystem_list",
            verdict="ALLOW",
            reason="放行",
            assessedBy="mock-classifier",
            occurredAt="2026-09-28T00:00:00.000Z",
        ),
    ]
    barrier = StreamBarrier(classifier=mock_classifier)
    cb = RejectionCircuitBreaker(task_id="task-plan-shared-cb", threshold=3)

    decisions = [
        # 第一步：bad -> good -> summary
        ToolCallDecision(
            kind="tool_call",
            callId="c-bad",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="c-good-1",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        StepCompleteDecision(kind="step_complete", result="步骤1完成"),
        # 第二步：good -> summary
        ToolCallDecision(
            kind="tool_call",
            callId="c-good-2",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(kind="summary", reply="步骤2完成", facts=[]),
    ]
    model = ScriptedModel(decisions)
    channel = FakeChannel([list_result(), list_result()])
    plan = [
        PlanStepDto(description="步骤一列文件", capability="filesystem_list"),
        PlanStepDto(description="步骤二列文件", capability="filesystem_list"),
    ]

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="执行多步任务",
        visible_capabilities=VISIBLE,
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(maxSteps=10, maxToolCalls=10),
        stream=None,
        sidecar_barrier=barrier,
        circuit_breaker=cb,
    )
    barrier.close()

    assert isinstance(result, RunTaskCompleted)
    assert result.status == "completed"
    event_types = [e.type for e in result.events]
    assert event_types.count("sidecar_inspected") == 3
    # 验证 cb 被两步共同更新且最终状态为 CLOSED（最后一次调用是 ALLOW 使得成功重置）
    assert cb.task_id == "task-plan-shared-cb"
    assert cb.state == "CLOSED"


def test_plan_and_execute_strategy_trips_circuit_breaker_and_halts():
    """PlanAndExecuteStrategy 连续被拦截触发熔断时，任务终止并发出 circuit_breaker_tripped 事件。"""
    strategy = PlanAndExecuteStrategy()
    mock_classifier = MagicMock()
    # 连续 2 次拦截达到阈值 2
    mock_classifier.classify.side_effect = [
        SidecarAssessment(
            callId="c-bad-1",
            capability="filesystem_list",
            verdict="REJECT_WITH_FEEDBACK",
            riskCategory="DESTRUCTIVE_COMMAND",
            reason="连续违规 1",
            remediation="不要违规",
            assessedBy="mock-classifier",
            occurredAt="2026-09-28T00:00:00.000Z",
        ),
        SidecarAssessment(
            callId="c-bad-2",
            capability="filesystem_list",
            verdict="REJECT_WITH_FEEDBACK",
            riskCategory="DESTRUCTIVE_COMMAND",
            reason="连续违规 2",
            remediation="不要违规",
            assessedBy="mock-classifier",
            occurredAt="2026-09-28T00:00:00.000Z",
        ),
    ]
    barrier = StreamBarrier(classifier=mock_classifier)
    cb = RejectionCircuitBreaker(task_id="task-trip", threshold=2)

    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="c-bad-1",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="c-bad-2",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
    ]
    model = ScriptedModel(decisions)
    channel = FakeChannel([])
    plan = [
        PlanStepDto(description="步骤一列文件", capability="filesystem_list"),
        PlanStepDto(description="步骤二列文件", capability="filesystem_list"),
    ]

    result = strategy.execute(
        model=model,
        channel=channel,
        goal="执行多步任务",
        visible_capabilities=VISIBLE,
        plan=plan,
        history=[],
        profile=None,
        budget=Budget(maxSteps=10, maxToolCalls=10),
        stream=None,
        sidecar_barrier=barrier,
        circuit_breaker=cb,
    )
    barrier.close()

    assert isinstance(result, RunTaskFailed)
    assert result.status == "failed"
    assert cb.state == "OPEN"
    event_types = [e.type for e in result.events]
    assert "circuit_breaker_tripped" in event_types


def test_handle_run_task_injects_sidecar_deps():
    """handle_run_task 必须为任务注入专属 circuit_breaker 与 sidecar 屏障。"""
    captured_kwargs = {}

    class SpyStrategy:
        def execute(self, **kwargs):
            nonlocal captured_kwargs
            captured_kwargs = kwargs
            return RunTaskCompleted(
                status="completed",
                reply="OK",
                facts=[],
                events=[],
            )

    deps = RuntimeDeps(
        channel=FakeChannel([]),
        model_factory=lambda: ScriptedModel([]),
        strategy=SpyStrategy(),
        capabilities=[CapabilityDescriptor(name="filesystem_list", kind="READ", description="list files")],
    )

    req = Request(
        jsonrpc="2.0",
        id="req-test-run",
        method="agent.run_task",
        params=RunTaskParams(
            taskId="my-custom-task-42",
            goal="测试 Sidecar 注入",
            plan=[PlanStepDto(description="步骤一", capability="filesystem_list")],
        ).model_dump(exclude_none=True),
    )

    resp = handle_run_task(req, deps)
    assert resp.get("result", {}).get("status") == "completed"
    assert "circuit_breaker" in captured_kwargs
    assert captured_kwargs["circuit_breaker"].task_id == "my-custom-task-42"
    assert "sidecar_barrier" in captured_kwargs
    assert captured_kwargs["sidecar_barrier"] is not None
    assert "sidecar_llm" in captured_kwargs

