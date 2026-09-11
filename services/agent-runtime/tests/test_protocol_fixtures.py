import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from personal_agent.protocol.models import (
    CapabilityFailure,
    DocumentExtractPdfParams,
    DocumentExtractPdfResult,
    FilesystemListParams,
    FilesystemListResult,
    HostExecuteToolParams,
    HostExecuteToolRequest,
    HostExecuteToolResponse,
    InitializeParams,
    InitializeResult,
    Request,
    Response,
)

FIXTURES_DIR = (
    Path(__file__).resolve().parents[3] / "packages" / "protocol" / "fixtures"
)


def _load(name: str) -> dict:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def _pick(raw: dict, path: str):
    """按点路径取嵌套字段。

    capability 的 arguments 住在 params.arguments 里，一层下标拿不到。
    取不到就直接 fail，不要让后面的 model_validate 收到 None 再报一个
    指向错误现场的 ValidationError。
    """
    node: object = raw
    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            pytest.fail(f"fixture 里取不到字段 {path}")
        node = node[key]
    return node


# 与 packages/protocol/tests/envelope.test.ts 的 legalCases 一一对应。
# 两边条目数或 field 不一致，说明有一侧偷偷放宽了，这里就是抓漂移的地方。
@pytest.mark.parametrize(
    ("name", "envelope", "payload", "field"),
    [
        ("initialize.request.json", Request, InitializeParams, "params"),
        ("initialize.response.json", Response, InitializeResult, "result"),
        ("ping.request.json", Request, None, "params"),
        ("ping.response.json", Response, None, "result"),
        # filesystem.list 不再是 TS→Python 的独立 method（执行体已移到 host 侧），
        # 它的 params/result 挂在 host.execute_tool 的 arguments/result 上。
        (
            "host-filesystem-list.request.json",
            HostExecuteToolRequest,
            HostExecuteToolParams,
            "params",
        ),
        (
            "host-filesystem-list.request.json",
            HostExecuteToolRequest,
            FilesystemListParams,
            "params.arguments",
        ),
        # FilesystemListResult 只钉 entries。host result 里的 ok 会被默认
        # extra='ignore' 丢掉，ok 由 envelope 层的 HostExecuteToolResult 负责。
        (
            "host-filesystem-list.response.json",
            HostExecuteToolResponse,
            FilesystemListResult,
            "result",
        ),
        (
            "host-execute-tool.request.json",
            HostExecuteToolRequest,
            HostExecuteToolParams,
            "params",
        ),
        (
            "host-execute-tool.request.json",
            HostExecuteToolRequest,
            DocumentExtractPdfParams,
            "params.arguments",
        ),
        (
            "host-execute-tool.response.json",
            HostExecuteToolResponse,
            DocumentExtractPdfResult,
            "result",
        ),
        # 业务失败（PDF 损坏等）走 result 不走 error，形状由 CapabilityFailure 钉。
        (
            "host-execute-tool.failure.response.json",
            HostExecuteToolResponse,
            CapabilityFailure,
            "result",
        ),
    ],
)
def test_legal_fixtures_are_accepted(name, envelope, payload, field):
    raw = _load(name)
    envelope.model_validate(raw)
    if payload is not None:
        payload.model_validate(_pick(raw, field))


def test_illegal_fixtures_are_not_accepted():
    invalid_dir = FIXTURES_DIR / "invalid"
    for path in sorted(invalid_dir.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        # host- 前缀必须先判：Envelope 的 Request 不校验 id 命名空间和
        # capability 白名单，用它校验这三个 fixture 会全部通过。
        if path.name.startswith("host-request-"):
            with pytest.raises(ValidationError):
                HostExecuteToolRequest.model_validate(raw)
        elif path.name.startswith("host-response-"):
            with pytest.raises(ValidationError):
                HostExecuteToolResponse.model_validate(raw)
        elif path.name.startswith("request-"):
            with pytest.raises(ValidationError):
                Request.model_validate(raw)
        elif path.name.startswith("response-"):
            with pytest.raises(ValidationError):
                Response.model_validate(raw)
        else:
            pytest.fail(f"未知前缀的非法 fixture: {path.name}")


def test_host_schemas_do_not_drift_from_envelope():
    """host 的 Request/Response 没继承 Envelope，用这两条钉住包含关系。

    TS 侧 envelope.test.ts 有对称的一组。两边任一放宽都会在这里红。
    """
    req = _load("host-execute-tool.request.json")
    HostExecuteToolRequest.model_validate(req)
    Request.model_validate(req)

    for name in (
        "host-execute-tool.response.json",
        "host-execute-tool.failure.response.json",
    ):
        resp = _load(name)
        HostExecuteToolResponse.model_validate(resp)
        Response.model_validate(resp)


# 与 packages/protocol/tests/envelope.test.ts 的「InitializeParams 的能力清单约束」
# 一一对应。两边判定不一致就是契约漂移。
def test_initialize_params_capabilities_constraints():
    legal = {
        "protocolVersion": "0.1",
        "capabilities": [
            {
                "name": "filesystem.list",
                "kind": "READ",
                "description": "列出授权根目录下的条目",
            }
        ],
        "client": {"name": "personal-agent-electron", "version": "0.1.0"},
    }
    InitializeParams.model_validate(legal)

    # 缺字段必须拒。给默认空数组的话，TS 侧漏传与“真的没有可见能力”
    # 在 wire 上无法分辨。
    without = {k: v for k, v in legal.items() if k != "capabilities"}
    with pytest.raises(ValidationError):
        InitializeParams.model_validate(without)

    # 单个对象而非数组：TS 侧漏写 z.array() 时会接受这个形状。
    with pytest.raises(ValidationError):
        InitializeParams.model_validate(
            {**legal, "capabilities": legal["capabilities"][0]}
        )

    # 空数组合法：一个能力都不可见是合法配置，不是错误。
    InitializeParams.model_validate({**legal, "capabilities": []})

    with pytest.raises(ValidationError):
        InitializeParams.model_validate(
            {
                **legal,
                "capabilities": [{**legal["capabilities"][0], "description": ""}],
            }
        )

    with pytest.raises(ValidationError):
        InitializeParams.model_validate(
            {
                **legal,
                "capabilities": [
                    {**legal["capabilities"][0], "name": "filesystem.delete"}
                ],
            }
        )
