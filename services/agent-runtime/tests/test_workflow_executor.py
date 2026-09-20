"""workflow/executor.py 的行为测试。"""

from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
    RunTaskCompleted,
    RunTaskFailed,
    SummaryFact,
)
from personal_agent.shared import (
    EVENT_BUDGET_EXHAUSTED,
    EVENT_TASK_COMPLETED,
    EVENT_TASK_FAILED,
    EVENT_TASK_STARTED,
    EVENT_TOOL_CALLED,
    EVENT_TOOL_RESULT,
    Budget,
    HostChannelClosed,
)
from personal_agent.workflow.definition import WorkflowDefinition, WorkflowStep
from personal_agent.workflow.executor import WorkflowExecutor


class FakeHostChannel:
    """可控的 HostChannel 替身，按顺序返回预设结果或记录调用参数。"""

    def __init__(
        self,
        responses: list[HostExecuteToolResult | Exception] | None = None,
    ) -> None:
        self._responses = list(responses or [])
        self.calls: list[HostExecuteToolParams] = []

    def call_host(self, params: HostExecuteToolParams) -> HostExecuteToolResult:
        self.calls.append(params)
        if not self._responses:
            return HostExecuteToolResult(ok=True)
        resp = self._responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


def test_workflow_executor_golden_run():
    # 模拟两步工作流：列出目录 -> 提取第一个文件
    step1 = WorkflowStep(
        id="list",
        capability="filesystem.list",
        description="列出文件",
        resolve_args=lambda s: {"rootId": s.inputs["rootId"]},
    )
    step2 = WorkflowStep(
        id="extract",
        capability="document.extract_pdf",
        description="提取内容",
        resolve_args=lambda s: {"path": s.get_result("list")["entries"][0]["path"]},
    )

    def summary(s) -> tuple[str, list[SummaryFact]]:
        pdf_path = s.get_result("list")["entries"][0]["path"]
        pages = s.get_result("extract")["pages"]
        return (
            f"成功处理 {pdf_path}",
            [SummaryFact(text="第1页要点", pageRefs=[pages[0]["pageNumber"]])],
        )

    wf = WorkflowDefinition(
        id="demo_wf",
        name="双步工作流",
        steps=[step1, step2],
        produce_summary=summary,
    )

    channel = FakeHostChannel(
        [
            HostExecuteToolResult(
                ok=True,
                entries=[{"name": "doc.pdf", "path": "/downloads/doc.pdf"}],
            ),
            HostExecuteToolResult(
                ok=True,
                pages=[{"pageNumber": 1, "text": "第一页正文"}],
            ),
        ]
    )

    executor = WorkflowExecutor(channel=channel)
    outcome = executor.execute(wf, inputs={"rootId": "downloads"})

    assert isinstance(outcome, RunTaskCompleted)
    assert outcome.status == "completed"
    assert "成功处理 /downloads/doc.pdf" in outcome.reply
    assert len(outcome.facts) == 1
    assert outcome.facts[0].pageRefs == [1]

    # 验证参数推导正确且调用了2次
    assert len(channel.calls) == 2
    assert channel.calls[0].arguments == {"rootId": "downloads"}
    assert channel.calls[1].arguments == {"path": "/downloads/doc.pdf"}

    # 验证事件流事件类型稳定
    event_types = [e.type for e in outcome.events]
    assert event_types == [
        EVENT_TASK_STARTED,
        EVENT_TOOL_CALLED,
        EVENT_TOOL_RESULT,
        EVENT_TOOL_CALLED,
        EVENT_TOOL_RESULT,
        EVENT_TASK_COMPLETED,
    ]


def test_workflow_executor_stops_on_step_failure():
    step1 = WorkflowStep(
        id="step1",
        capability="filesystem.create_dir",
        description="创建目录",
        resolve_args=lambda s: {"path": "/bad/path"},
    )
    step2 = WorkflowStep(
        id="step2",
        capability="filesystem.move",
        description="移动文件",
        resolve_args=lambda s: {},
    )

    wf = WorkflowDefinition(
        id="fail_wf",
        name="失败工作流",
        steps=[step1, step2],
    )

    channel = FakeHostChannel(
        [
            HostExecuteToolResult(
                ok=False,
                code="PERMISSION_DENIED",
                reason="用户拒绝批准创建目录",
            ),
        ]
    )

    executor = WorkflowExecutor(channel=channel)
    outcome = executor.execute(wf)

    assert isinstance(outcome, RunTaskFailed)
    assert outcome.status == "failed"
    assert "PERMISSION_DENIED: 用户拒绝批准创建目录" in outcome.reason
    # 失败时第二步绝对不能执行
    assert len(channel.calls) == 1

    event_types = [e.type for e in outcome.events]
    assert event_types == [
        EVENT_TASK_STARTED,
        EVENT_TOOL_CALLED,
        EVENT_TOOL_RESULT,
        EVENT_TASK_FAILED,
    ]


def test_workflow_executor_budget_exhaustion():
    step1 = WorkflowStep(
        id="s1",
        capability="filesystem.list",
        description="s1",
        resolve_args=lambda s: {},
    )
    step2 = WorkflowStep(
        id="s2",
        capability="filesystem.list",
        description="s2",
        resolve_args=lambda s: {},
    )

    wf = WorkflowDefinition(id="b_wf", name="超预算", steps=[step1, step2])
    channel = FakeHostChannel()

    # 预算只允许 1 步
    executor = WorkflowExecutor(
        channel=channel, budget=Budget(maxSteps=1, maxToolCalls=1)
    )
    outcome = executor.execute(wf)

    assert isinstance(outcome, RunTaskFailed)
    assert "预算耗尽" in outcome.reason
    assert len(channel.calls) == 1

    event_types = [e.type for e in outcome.events]
    assert EVENT_BUDGET_EXHAUSTED in event_types
    assert EVENT_TASK_FAILED in event_types


def test_workflow_executor_channel_closed():
    step1 = WorkflowStep(
        id="s1",
        capability="filesystem.list",
        description="s1",
        resolve_args=lambda s: {},
    )
    wf = WorkflowDefinition(id="c_wf", name="连接关闭", steps=[step1])
    channel = FakeHostChannel([HostChannelClosed("管道断开")])

    executor = WorkflowExecutor(channel=channel)
    outcome = executor.execute(wf)

    assert isinstance(outcome, RunTaskFailed)
    assert "RUNTIME_CHANNEL_CLOSED" in outcome.reason
