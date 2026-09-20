"""workflow/golden_path.py —— Golden Path 工作流规格与执行测试。"""

import pytest

from personal_agent.protocol.models import (
    HostExecuteToolParams,
    HostExecuteToolResult,
    RunTaskCompleted,
)
from personal_agent.workflow.executor import WorkflowExecutor
from personal_agent.workflow.golden_path import (
    WorkflowPlanError,
    build_golden_path_workflow,
)


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


def test_golden_path_missing_required_read_capabilities_raises_error():
    # 缺少任一必选的 READ 能力，工作流必须构建失败（fail-closed）
    with pytest.raises(WorkflowPlanError, match="缺少必需能力"):
        build_golden_path_workflow(visible_capabilities=["filesystem.list"])


def test_golden_path_read_only_mode():
    # 只读模式：只给两个读能力，只生成 2 步
    wf = build_golden_path_workflow(
        visible_capabilities=["filesystem.list", "document.extract_pdf"]
    )
    assert len(wf.steps) == 2
    assert [s.capability for s in wf.steps] == [
        "filesystem.list",
        "document.extract_pdf",
    ]

    channel = FakeHostChannel(
        [
            HostExecuteToolResult(
                ok=True,
                entries=[{"name": "test.pdf", "path": "D:/downloads/test.pdf"}],
            ),
            HostExecuteToolResult(
                ok=True,
                pages=[
                    {"pageNumber": 1, "text": "第一页内容"},
                    {"pageNumber": 2, "text": "第二页内容"},
                ],
            ),
        ]
    )

    executor = WorkflowExecutor(channel=channel)
    outcome = executor.execute(wf, inputs={"rootId": "downloads"})

    assert isinstance(outcome, RunTaskCompleted)
    assert outcome.status == "completed"
    assert len(outcome.facts) == 2
    assert outcome.facts[0].pageRefs == [1]
    assert outcome.facts[1].pageRefs == [2]
    assert len(channel.calls) == 2
    assert channel.calls[0].arguments == {"rootId": "downloads"}
    assert channel.calls[1].arguments == {"path": "D:/downloads/test.pdf"}


def test_golden_path_full_five_steps():
    # 完整模式：5 个能力全给，跑满 5 步
    all_caps = [
        "filesystem.list",
        "document.extract_pdf",
        "filesystem.create_dir",
        "filesystem.move",
        "scheduler.create",
    ]
    wf = build_golden_path_workflow(visible_capabilities=all_caps)
    assert len(wf.steps) == 5

    channel = FakeHostChannel(
        [
            HostExecuteToolResult(
                ok=True,
                entries=[{"name": "paper.pdf", "path": "D:/Downloads/paper.pdf"}],
            ),
            HostExecuteToolResult(
                ok=True,
                pages=[{"pageNumber": 1, "text": "报告内容"}],
            ),
            HostExecuteToolResult(ok=True),  # create_dir
            HostExecuteToolResult(ok=True),  # move
            HostExecuteToolResult(ok=True, reminderId="rem-1"),  # scheduler.create
        ]
    )

    executor = WorkflowExecutor(channel=channel)
    outcome = executor.execute(wf, inputs={"rootId": "downloads"})

    assert isinstance(outcome, RunTaskCompleted)
    assert outcome.status == "completed"
    assert "已把 paper.pdf 移到 Reading" in outcome.reply
    assert len(outcome.facts) == 1
    assert outcome.facts[0].pageRefs == [1]

    # 验证 5 次调用的参数链式传递
    assert len(channel.calls) == 5
    assert channel.calls[0].arguments == {"rootId": "downloads"}
    assert channel.calls[1].arguments == {"path": "D:/Downloads/paper.pdf"}
    # create_dir 应在 Downloads 下创建 Reading
    assert channel.calls[2].arguments["path"].replace("\\", "/").endswith(
        "Downloads/Reading"
    )
    # move 的 source 和 target
    assert channel.calls[3].arguments["source"] == "D:/Downloads/paper.pdf"
    assert channel.calls[3].arguments["target"].replace("\\", "/").endswith(
        "Downloads/Reading/paper.pdf"
    )
    # scheduler.create 应带 remindAt 和 message
    assert "remindAt" in channel.calls[4].arguments
    assert "paper.pdf" in channel.calls[4].arguments["message"]
