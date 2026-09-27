"""ReActLoop 行为测试。

测试可复用的 ReAct 内循环：
1. 正常执行工具调用并把观察喂回模型
2. 遇到 summary 终态完成任务并验证 facts
3. 遇到 step_complete 时在 stop_on_step_complete=True 时正常中断退出
4. 预算双维限制（步数、工具调用数）
5. 工具调用失败（ok=False）正常透传并计入步数
"""


from pathlib import Path
from unittest.mock import MagicMock

from personal_agent.context import ContextManager
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
    HostExecuteToolParams,
    HostExecuteToolResult,
    SidecarAssessment,
)
from personal_agent.react_loop import ReActLoop, ReActOutcome
from personal_agent.scripted_model import ScriptedModel

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


def make_loop(results, decisions, budget=None, plan=None):
    channel = FakeChannel(results)
    model = ScriptedModel(decisions)
    context = ContextManager(plan=plan or ())
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=budget or Budget(maxSteps=5, maxToolCalls=3),
    )
    return loop, model, channel, context


def test_react_loop_completes_with_summary():
    """场景：模型发出工具调用，获得观察后直接给出摘要。"""
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-1",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(
            kind="summary",
            reply="扫描完成，未发现异常",
            facts=[],
        ),
    ]
    loop, _, _, _ = make_loop([list_result()], decisions)

    outcome = loop.run("检查目录", VISIBLE, stop_on_step_complete=False)

    # 契约底线断言（保留）
    assert isinstance(outcome, ReActOutcome)
    assert outcome.kind == "completed"
    assert outcome.reply == "扫描完成，未发现异常"
    assert outcome.steps_used == 2
    assert outcome.tool_calls_used == 1


def test_react_loop_stops_on_step_complete_when_configured():
    """场景：处于 PlanAndExecute 步骤内，模型输出 step_complete，内循环应在此时正常退出。"""
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-1",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        StepCompleteDecision(
            kind="step_complete",
            result="已找到目标 a.pdf 文件",
        ),
    ]
    loop, _, _, _ = make_loop([list_result()], decisions)

    outcome = loop.run("查找文件", VISIBLE, stop_on_step_complete=True)

    # 契约底线断言（保留）
    assert isinstance(outcome, ReActOutcome)
    assert outcome.kind == "step_done"
    assert outcome.steps_used == 2
    assert outcome.tool_calls_used == 1


def test_react_loop_triggers_budget_exhaustion():
    """场景：模型无限重复调用工具，超过预算限制时安全终止。"""
    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId=f"call-{i}",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        )
        for i in range(10)
    ]
    results = [list_result() for _ in range(10)]
    loop, _, _, _ = make_loop(
        results, decisions, budget=Budget(maxSteps=3, maxToolCalls=2)
    )

    outcome = loop.run("无限执行", VISIBLE)

    # 契约底线断言（保留）
    assert isinstance(outcome, ReActOutcome)
    assert outcome.kind == "budget_exhausted"
    assert "预算耗尽" in (outcome.reason or "")


def test_react_loop_with_sidecar_allow():
    """场景：配置了 StreamBarrier，Sidecar 放行后正常执行工具，发出 sidecar_inspected 事件。"""
    barrier = StreamBarrier()
    cb = RejectionCircuitBreaker(task_id="task-sidecar-1", threshold=3)

    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-1",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(
            kind="summary",
            reply="扫描完成",
            facts=[],
        ),
    ]
    channel = FakeChannel([list_result()])
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=3),
        sidecar_barrier=barrier,
        circuit_breaker=cb,
    )

    outcome = loop.run("扫描安全目录", VISIBLE)
    barrier.close()

    assert outcome.kind == "completed"
    assert outcome.steps_used == 2
    assert outcome.tool_calls_used == 1
    event_types = [e.type for e in outcome.events]
    assert "sidecar_inspected" in event_types
    assert cb.consecutive_rejections == 0


def test_react_loop_with_sidecar_reject_and_self_heal():
    """场景：Sidecar 拦截危险操作，门控自愈喂回 Observation，模型调整决策并完成。"""
    mock_classifier = MagicMock()
    mock_classifier.classify.side_effect = [
        SidecarAssessment(
            callId="call-bad",
            capability="filesystem_list",
            verdict="REJECT_WITH_FEEDBACK",
            riskCategory="DESTRUCTIVE_COMMAND",
            reason="高风险调用",
            remediation="请仅查询安全路径",
            assessedBy="mock",
            occurredAt="2026-09-27T00:00:00.000Z",
        ),
        SidecarAssessment(
            callId="call-good",
            capability="filesystem_list",
            verdict="ALLOW",
            reason="安全通过",
            assessedBy="mock",
            occurredAt="2026-09-27T00:00:00.000Z",
        ),
    ]
    barrier = StreamBarrier(classifier=mock_classifier)
    cb = RejectionCircuitBreaker(task_id="task-sidecar-2", threshold=3)

    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-bad",
            capability="filesystem_list",
            arguments={"rootId": "root"},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="call-good",
            capability="filesystem_list",
            arguments={"rootId": "downloads"},
        ),
        SummaryDecision(
            kind="summary",
            reply="自愈重试后成功",
            facts=[],
        ),
    ]
    channel = FakeChannel([list_result()])
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=3),
        sidecar_barrier=barrier,
        circuit_breaker=cb,
    )

    outcome = loop.run("自愈测试", VISIBLE)
    barrier.close()

    assert outcome.kind == "completed"
    assert outcome.tool_calls_used == 2
    # 宿主 channel 只实际被调用了 1 次（第一次被拦截未下发）
    assert len(channel.calls) == 1
    # 上下文中记录了失败的合成 Observation
    failed_obs = context.observations[0]
    assert failed_obs.ok is False
    assert failed_obs.payload.get("error") == "sidecar_rejection"


def test_react_loop_with_sidecar_breaker_trips():
    """场景：连续违规达到阈值，熔断器跳闸，ReAct 循环终止并发出 circuit_breaker_tripped 事件。"""
    mock_classifier = MagicMock()
    mock_classifier.classify.return_value = SidecarAssessment(
        callId="call-bad",
        capability="filesystem_list",
        verdict="REJECT_WITH_FEEDBACK",
        riskCategory="DESTRUCTIVE_COMMAND",
        reason="高风险调用",
        assessedBy="mock",
        occurredAt="2026-09-27T00:00:00.000Z",
    )
    barrier = StreamBarrier(classifier=mock_classifier)
    cb = RejectionCircuitBreaker(task_id="task-sidecar-3", threshold=2)

    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-1",
            capability="filesystem_list",
            arguments={},
        ),
        ToolCallDecision(
            kind="tool_call",
            callId="call-2",
            capability="filesystem_list",
            arguments={},
        ),
    ]
    channel = FakeChannel([])
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=3),
        sidecar_barrier=barrier,
        circuit_breaker=cb,
    )

    outcome = loop.run("熔断测试", VISIBLE)
    barrier.close()

    assert outcome.kind == "failed"
    assert cb.state == "OPEN"
    event_types = [e.type for e in outcome.events]
    assert "circuit_breaker_tripped" in event_types


def test_react_loop_with_sidecar_escalate_halts():
    """场景：Sidecar 判定高危操作需人工审批 (ESCALATE_TO_USER)，ReAct 循环立即中止。"""
    mock_classifier = MagicMock()
    mock_classifier.classify.return_value = SidecarAssessment(
        callId="call-danger",
        capability="terminal_execute",
        verdict="ESCALATE_TO_USER",
        riskCategory="DESTRUCTIVE_COMMAND",
        reason="检测到高危系统指令",
        assessedBy="mock",
        occurredAt="2026-09-27T00:00:00.000Z",
    )
    barrier = StreamBarrier(classifier=mock_classifier)
    cb = RejectionCircuitBreaker(task_id="task-sidecar-esc", threshold=3)

    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-danger",
            capability="terminal_execute",
            arguments={"cmd": "rm -rf /"},
        ),
    ]
    channel = FakeChannel([])
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=3),
        sidecar_barrier=barrier,
        circuit_breaker=cb,
    )

    outcome = loop.run("执行危险命令", ["terminal_execute"])
    barrier.close()

    assert outcome.kind == "failed"
    assert "高风险操作需人工审批" in (outcome.reason or "")
    assert len(channel.calls) == 0


def test_react_loop_with_sidecar_compaction_and_persistence():
    """场景：工具执行返回超长输出（>1200 字符），自动落盘本地临时文件，轨迹事件记录 rawOutputPath，上下文记录精简 Observation。"""
    mock_llm = MagicMock()
    mock_llm.compact_observation.return_value = MagicMock(
        summary="提取了大量表格数据",
        keyFacts=["共 1500 行"],
        originalChars=2000,
        compactedChars=80,
    )

    huge_content = "DATA_" * 400
    huge_result = {
        "ok": True,
        "content": huge_content,
    }

    decisions = [
        ToolCallDecision(
            kind="tool_call",
            callId="call-huge",
            capability="terminal_execute",
            arguments={"cmd": "dump.sh"},
        ),
        SummaryDecision(
            kind="summary",
            reply="任务完成",
            facts=[],
        ),
    ]
    channel = FakeChannel([huge_result])
    model = ScriptedModel(decisions)
    context = ContextManager(plan=())
    loop = ReActLoop(
        model=model,
        channel=channel,
        context=context,
        budget=Budget(maxSteps=5, maxToolCalls=3),
        sidecar_llm=mock_llm,
    )

    outcome = loop.run("导出长数据", ["terminal_execute"])

    assert outcome.kind == "completed"
    # 验证上下文中的 Observation 是精炼后的且携带 raw_output_path
    obs = context.observations[0]
    assert obs.payload.get("compacted") is True
    assert obs.payload.get("summary") == "提取了大量表格数据"
    raw_path = obs.payload.get("raw_output_path")
    assert raw_path is not None
    assert Path(raw_path).exists()
    assert huge_content in Path(raw_path).read_text(encoding="utf-8")

    # 验证轨迹事件中的 EVENT_TOOL_RESULT 记录了 rawOutputPath
    tool_res_events = [e for e in outcome.events if e.type == "tool_result"]
    assert len(tool_res_events) == 1
    assert tool_res_events[0].payload.get("compacted") is True
    assert tool_res_events[0].payload.get("rawOutputPath") == raw_path



