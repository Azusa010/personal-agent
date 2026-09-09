import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from personal_agent.protocol.models import (
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


@pytest.mark.parametrize(
    ("name", "envelope", "payload", "field"),
    [
        ("initialize.request.json", Request, InitializeParams, "params"),
        ("initialize.response.json", Response, InitializeResult, "result"),
        ("ping.request.json", Request, None, "params"),
        ("ping.response.json", Response, None, "result"),
        ("filesystem-list.request.json", Request, FilesystemListParams, "params"),
        ("filesystem-list.response.json", Response, FilesystemListResult, "result"),
        (
            "host-execute-tool.request.json",
            HostExecuteToolRequest,
            HostExecuteToolParams,
            "params",
        ),
        # result 的具体形状不在契约层校验（只钉 ok），payload 给 None。
        (
            "host-execute-tool.response.json",
            HostExecuteToolResponse,
            None,
            "result",
        ),
        (
            "host-execute-tool.failure.response.json",
            HostExecuteToolResponse,
            None,
            "result",
        ),
    ],
)
def test_legal_fixtures_are_accepted(name, envelope, payload, field):
    raw = _load(name)
    envelope.model_validate(raw)
    if payload is not None:
        payload.model_validate(raw[field])


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
