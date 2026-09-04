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

