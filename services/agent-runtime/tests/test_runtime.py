import json

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
    line = json.dumps({
        "jsonrpc": "2.0", "id": "10", "method": "system.initialize",
        "params": {"protocolVersion": "0.1",
                   "client": {"name": "personal-agent-electron", "version": "0.1.0"}},
    })
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
