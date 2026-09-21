"""测试 runtime.py 的 agent.run_workflow 独立工作流 RPC 入口。"""

from personal_agent.protocol.models import (
    CapabilityDescriptor,
    HostExecuteToolParams,
    HostExecuteToolResult,
)
from personal_agent.runtime import RuntimeDeps, dispatch


class FakeHostChannel:
    """可控的 HostChannel 替身。"""

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


def test_dispatch_run_workflow_golden_path_success():
    req = {
        "jsonrpc": "2.0",
        "id": "wf-1",
        "method": "agent.run_workflow",
        "params": {
            "taskId": "task-100",
            "workflowId": "golden_path",
            "inputs": {"rootId": "downloads"},
        },
    }

    channel = FakeHostChannel(
        [
            HostExecuteToolResult(
                ok=True,
                entries=[{"name": "test.pdf", "path": "D:/downloads/test.pdf"}],
            ),
            HostExecuteToolResult(
                ok=True,
                pages=[{"pageNumber": 1, "text": "内容"}],
            ),
            HostExecuteToolResult(ok=True),  # create_dir
            HostExecuteToolResult(ok=True),  # move
            HostExecuteToolResult(ok=True),  # reminder
        ]
    )

    capabilities = [
        CapabilityDescriptor(name="filesystem_list", kind="READ", description="list"),
        CapabilityDescriptor(
            name="document_extract_pdf", kind="READ", description="extract"
        ),
        CapabilityDescriptor(
            name="filesystem_create_dir", kind="WRITE", description="create"
        ),
        CapabilityDescriptor(name="filesystem_move", kind="WRITE", description="move"),
        CapabilityDescriptor(
            name="scheduler_create", kind="WRITE", description="reminder"
        ),
    ]

    deps = RuntimeDeps(channel=channel, capabilities=capabilities)

    resp = dispatch(req, deps)

    assert resp["id"] == "wf-1"
    assert "result" in resp
    assert resp["result"]["status"] == "completed"
    assert "已把 test.pdf 移到 Reading" in resp["result"]["reply"]
    assert len(resp["result"]["facts"]) == 1
    assert resp["result"]["facts"][0]["pageRefs"] == [1]
    assert len(channel.calls) == 5


def test_dispatch_run_workflow_unknown_id():
    req = {
        "jsonrpc": "2.0",
        "id": "wf-2",
        "method": "agent.run_workflow",
        "params": {
            "taskId": "task-101",
            "workflowId": "non_existent_workflow",
        },
    }

    deps = RuntimeDeps(channel=FakeHostChannel())
    resp = dispatch(req, deps)

    assert resp["id"] == "wf-2"
    assert "error" in resp
    assert resp["error"]["code"] == "WORKFLOW_NOT_FOUND"


def test_dispatch_run_workflow_invalid_params():
    req = {
        "jsonrpc": "2.0",
        "id": "wf-3",
        "method": "agent.run_workflow",
        "params": {
            # 缺少必填的 taskId 与 workflowId
        },
    }

    deps = RuntimeDeps(channel=FakeHostChannel())
    resp = dispatch(req, deps)

    assert resp["id"] == "wf-3"
    assert "error" in resp
    assert resp["error"]["code"] == "PROTOCOL_INVALID_REQUEST"
