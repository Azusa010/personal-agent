"""tests/test_json_parser.py —— 模型输出 JSON 容错解析器的单元测试。"""

import pytest

from personal_agent.conversation.model.gateway import ModelCallFailed
from personal_agent.conversation.model.json_parser import safe_parse_model_json


def test_safe_parse_clean_json_dict():
    """干净标准 JSON 字典应直接原样解析。"""
    raw = '{"kind": "tool_call", "callId": "call-1", "arguments": {"path": "/tmp"}}'
    parsed = safe_parse_model_json(raw)
    assert isinstance(parsed, dict)
    assert parsed["kind"] == "tool_call"
    assert parsed["callId"] == "call-1"
    assert parsed["arguments"]["path"] == "/tmp"


def test_safe_parse_clean_json_list():
    """干净标准 JSON 数组应直接原样解析。"""
    raw = '[{"description": "第 1 步"}, {"description": "第 2 步"}]'
    parsed = safe_parse_model_json(raw)
    assert isinstance(parsed, list)
    assert len(parsed) == 2
    assert parsed[0]["description"] == "第 1 步"


def test_safe_parse_extra_data_trailing_text():
    """复现实际 BUG：模型在 JSON 闭合后输出了多余文本或解释。"""
    raw = (
        '{"kind": "summary", "reply": "任务完成", "facts": []}\n\n'
        "请确认以上结果，如有疑问随时告知。(char 280)"
    )
    parsed = safe_parse_model_json(raw)
    assert isinstance(parsed, dict)
    assert parsed["kind"] == "summary"
    assert parsed["reply"] == "任务完成"
    assert parsed["facts"] == []


def test_safe_parse_markdown_code_fences():
    """模型用 markdown 围栏 ```json 包裹 JSON。"""
    raw = '```json\n{"steps": [{"description": "第一步", "capability": "filesystem_list"}]}\n```'
    parsed = safe_parse_model_json(raw)
    assert isinstance(parsed, dict)
    assert "steps" in parsed
    assert len(parsed["steps"]) == 1
    assert parsed["steps"][0]["capability"] == "filesystem_list"


def test_safe_parse_leading_preamble_and_trailing_fence():
    """模型前面有引导说明，尾部有孤立反引号或备注。"""
    raw = (
        "好的，为您规划的执行步骤如下：\n"
        '{"steps": [{"description": "读取文件"}]}\n'
        "```\n希望对您有帮助！"
    )
    parsed = safe_parse_model_json(raw)
    assert isinstance(parsed, dict)
    assert len(parsed["steps"]) == 1
    assert parsed["steps"][0]["description"] == "读取文件"


def test_safe_parse_empty_or_whitespace_raises():
    """输入为空或纯空白时，必须抛出 ModelCallFailed。"""
    with pytest.raises(ModelCallFailed) as e:
        safe_parse_model_json("")
    assert "为空" in e.value.reason

    with pytest.raises(ModelCallFailed) as e:
        safe_parse_model_json("   \n\t  ")
    assert "为空" in e.value.reason


def test_safe_parse_pure_conversational_text_raises():
    """纯自然语言文本（无法修复出 JSON 结构体）必须抛出 ModelCallFailed 且带有 '不是合法 JSON' 关键字。"""
    with pytest.raises(ModelCallFailed) as e:
        safe_parse_model_json("我觉得这个任务不用执行任何工具，直接结束就行……")
    assert "不是合法 JSON" in e.value.reason


def test_safe_parse_scalar_json_raises():
    """即便解析成合法 JSON 标量（如纯数字、布尔值、字符串），只要不是 dict 或 list 容器即判定非法。"""
    with pytest.raises(ModelCallFailed) as e:
        safe_parse_model_json("123456")
    assert "不是合法 JSON" in e.value.reason

    with pytest.raises(ModelCallFailed) as e:
        safe_parse_model_json('"just a plain json string"')
    assert "不是合法 JSON" in e.value.reason


def test_parse_tool_call_arguments_empty_or_none():
    from personal_agent.conversation.model.json_parser import parse_tool_call_arguments

    assert parse_tool_call_arguments(None) == {}
    assert parse_tool_call_arguments("") == {}
    assert parse_tool_call_arguments("   ") == {}
    assert parse_tool_call_arguments("{}") == {}
    assert parse_tool_call_arguments("None") == {}
    assert parse_tool_call_arguments("null") == {}
    assert parse_tool_call_arguments("()") == {}


def test_parse_tool_call_arguments_dict_and_standard_json():
    from personal_agent.conversation.model.json_parser import parse_tool_call_arguments

    assert parse_tool_call_arguments({"rootId": "downloads"}) == {"rootId": "downloads"}
    assert parse_tool_call_arguments('{"rootId": "downloads"}') == {"rootId": "downloads"}


def test_parse_tool_call_arguments_windows_path_and_missing_braces():
    from personal_agent.conversation.model.json_parser import parse_tool_call_arguments

    raw_path = '{"path": "C:/Users/Azusama/Downloads/report.pdf"}'
    parsed = parse_tool_call_arguments(raw_path)
    assert parsed["path"] == "C:/Users/Azusama/Downloads/report.pdf"

    # 缺少外层大括号
    assert parse_tool_call_arguments('"path": "report.pdf"') == {"path": "report.pdf"}
    assert parse_tool_call_arguments("'path': 'report.pdf'") == {"path": "report.pdf"}


def test_parse_tool_call_arguments_python_call_syntax():
    from personal_agent.conversation.model.json_parser import parse_tool_call_arguments

    # 函数调用包裹语法
    assert parse_tool_call_arguments('document_extract_pdf(path="weekly-03.pdf")') == {
        "path": "weekly-03.pdf"
    }
    # 纯关键字参数语法
    assert parse_tool_call_arguments('rootId="downloads", path="TeamB"') == {
        "rootId": "downloads",
        "path": "TeamB",
    }


def test_parse_tool_call_arguments_corrupt_raises_model_call_failed():
    from personal_agent.conversation.model.json_parser import parse_tool_call_arguments

    with pytest.raises(ModelCallFailed) as e:
        parse_tool_call_arguments("{not_json")
    assert "不是合法 JSON" in e.value.reason

