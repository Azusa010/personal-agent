import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from personal_agent.protocol.models import (
    FilesystemListParams,
    FilesystemListResult,
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
        if path.name.startswith("request-"):
            with pytest.raises(ValidationError):
                Request.model_validate(raw)
        elif path.name.startswith("response-"):
            with pytest.raises(ValidationError):
                Response.model_validate(raw)
        else:
            pytest.fail(f"未知前缀的非法 fixture: {path.name}")
