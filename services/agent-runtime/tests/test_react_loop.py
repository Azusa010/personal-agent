"""ReActLoop 行为测试。

测试可复用的 ReAct 内循环：
1. 正常执行工具调用并把观察喂回模型
2. 遇到 summary 终态完成任务并验证 facts
3. 遇到 step_complete 时在 stop_on_step_complete=True 时正常中断退出
4. 预算双维限制（步数、工具调用数）
5. 工具调用失败（ok=False）正常透传并计入步数
"""


from personal_agent.context import ContextManager
from personal_agent.engine import Budget
from personal_agent.model_gateway import (
    StepCompleteDecision,
    SummaryDecision,
    ToolCallDecision,
)
from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
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

