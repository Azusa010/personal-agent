from typing import get_args

from personal_agent.conversation.model.tool_schema_generator import (
    TOOL_DESCRIPTIONS,
    TOOL_PARAM_MODELS,
    generate_all_tool_schemas,
    generate_tool_schema,
)
from personal_agent.protocol.models import CapabilityId


def test_generator_covers_all_capability_ids():
    all_caps = get_args(CapabilityId)
    assert set(TOOL_PARAM_MODELS.keys()) == set(all_caps)
    assert set(TOOL_DESCRIPTIONS.keys()) == set(all_caps)

    schemas = generate_all_tool_schemas()
    assert set(schemas.keys()) == set(all_caps)


def test_generated_schema_structure():
    schemas = generate_all_tool_schemas()
    for cap, tool in schemas.items():
        assert tool["type"] == "function"
        fn = tool["function"]
        assert fn["name"] == cap
        assert isinstance(fn["description"], str) and len(fn["description"]) > 0
        params = fn["parameters"]
        assert params["type"] == "object"
        assert "properties" in params
        assert "title" not in params  # 顶层 title 冗余清理
        assert "additionalProperties" not in params


def test_generated_parameters_match_model():
    schema = generate_tool_schema("scheduler_create")
    fn = schema["function"]
    props = fn["parameters"]["properties"]
    assert "remindAt" in props
    assert "message" in props
    assert "ISO-8601" in props["remindAt"]["description"]
    assert fn["parameters"]["required"] == ["remindAt", "message"]


def test_generated_terminal_execute_schema():
    schema = generate_tool_schema("terminal_execute")
    fn = schema["function"]
    props = fn["parameters"]["properties"]
    assert "command" in props
    assert "cwd" in props
    assert "timeoutMs" in props
    assert "command" in fn["parameters"]["required"]
