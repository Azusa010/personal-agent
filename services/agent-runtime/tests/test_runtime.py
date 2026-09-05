import json
import os
from pathlib import Path

from _pytest.monkeypatch import MonkeyPatch

from personal_agent.runtime import handle_line


def test_ping_returns_empty_result():
    line = json.dumps(
        {"jsonrpc": "2.0", "id": "1", "method": "system.ping", "params": {}}
    )
    assert handle_line(line) == {"jsonrpc": "2.0", "id": "1", "result": {}}


def test_unknown_method_returns_error():
    line = json.dumps(
        {"jsonrpc": "2.0", "id": "2", "method": "system.nope", "params": {}}
    )
    resp = handle_line(line)
    assert resp["error"]["code"] == "METHOD_NOT_FOUND"
    assert resp["id"] == "2"


def test_invalid_json_returns_parse_error():
    resp = handle_line("{not json")
    assert resp["error"]["code"] == "PROTOCOL_INVALID_JSON"
    assert resp["id"] is None


def test_blank_line_returns_none():
    assert handle_line("   ") is None


def test_initialize_returns_server_info():
    line = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "10",
            "method": "system.initialize",
            "params": {
                "protocolVersion": "0.1",
                "client": {"name": "personal-agent-electron", "version": "0.1.0"},
            },
        }
    )
    resp = handle_line(line)
    assert resp["result"]["protocolVersion"] == "0.1"
    assert resp["result"]["server"]["name"] == "personal-agent-runtime"
    assert resp["result"]["server"]["version"] == "0.1.0"


def test_initialize_wrong_version_returns_error():
    line = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "11",
            "method": "system.initialize",
            "params": {
                "protocolVersion": "0.2",
                "client": {"name": "personal-agent-electron", "version": "0.1.0"},
            },
        }
    )
    resp = handle_line(line)
    assert resp["error"]["code"] == "PROTOCOL_INVALID_REQUEST"
    assert resp["id"] == "11"


def _make_pdf(path: Path, mtime: float, size: int) -> None:
    path.write_bytes(b"x" * size)
    os.utime(path, (mtime, mtime))


def test_filesystem_list_returns_sorted_entries(
    tmp_path: Path, monkeypatch: MonkeyPatch
):
    _make_pdf(tmp_path / "new.pdf", mtime=2_000_000.0, size=2048)
    _make_pdf(tmp_path / "old.pdf", mtime=1_000_000.0, size=512)
    monkeypatch.setenv("PERSONAL_AGENT_DOWNLOADS_DIR", str(tmp_path))

    line = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "20",
            "method": "filesystem.list",
            "params": {"rootId": "downloads"},
        }
    )

    resp = handle_line(line)
    entries = resp["result"]["entries"]
    assert [e["name"] for e in entries] == ["new.pdf", "old.pdf"]
    assert entries[0]["sizeBytes"] == 2048
    assert entries[0]["absolutePath"].endswith("/new.pdf")

def test_filesystem_list_invalid_root_returns_error():
    line = json.dumps(
        {"jsonrpc": "2.0", "id": "21", "method": "filesystem.list",
         "params": {"rootId": "secrets"}}
    )
    resp = handle_line(line)
    assert resp["error"]["code"] == "PROTOCOL_INVALID_REQUEST"
    assert resp["id"] == "21"


def test_filesystem_list_root_unavailable_returns_error(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_DOWNLOADS_DIR", str(tmp_path / "does-not-exist"))
    line = json.dumps(
        {"jsonrpc": "2.0", "id": "22", "method": "filesystem.list",
         "params": {"rootId": "downloads"}}
    )
    resp = handle_line(line)
    assert resp["error"]["code"] == "FILESYSTEM_ROOT_UNAVAILABLE"
    assert resp["id"] == "22"
