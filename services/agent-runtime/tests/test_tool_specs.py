"""TOOL_SPECS 工具说明通用化与无偏见测试。"""

from typing import get_args

from personal_agent.conversation.model.live_model import (
    TOOL_SCHEMAS,
    TOOL_SPECS,
    render_input,
)
from personal_agent.conversation.model.live_planner import render_plan_input
from personal_agent.model_gateway import ModelContext
from personal_agent.protocol.models import CapabilityId


def test_tool_specs_covers_all_registered_capabilities():
    # TOOL_SPECS 应当覆盖协议中定义的全部能力枚举，不多不少
    all_capabilities = set(get_args(CapabilityId))
    assert set(TOOL_SPECS) == all_capabilities


def test_tool_schemas_covers_all_registered_capabilities():
    # TOOL_SCHEMAS 应当覆盖协议中定义的全部能力枚举，并且符合 OpenAI function 格式
    all_capabilities = set(get_args(CapabilityId))
    assert set(TOOL_SCHEMAS) == all_capabilities
    for name, schema in TOOL_SCHEMAS.items():
        assert schema["type"] == "function"
        assert schema["function"]["name"] == name
        assert "parameters" in schema["function"]


def test_tool_specs_filesystem_list_is_generic_not_pdf_specific():
    # 彻底消除场景色彩：filesystem.list 是通用的目录扫描工具，不应硬编码限定为 PDF
    list_spec = TOOL_SPECS["filesystem.list"]
    assert "PDF" not in list_spec
    assert "pdf" not in list_spec
    assert "授权根" in list_spec
    assert "rootId" in list_spec


def test_all_tool_specs_provide_parameter_hints():
    # 每个能力都必须有标准的可读参数说明和 JSON 形状指引
    for spec in TOOL_SPECS.values():
        assert "参数" in spec
        assert "{" in spec and "}" in spec


def test_render_input_and_plan_input_only_render_visible_subset():
    # 当只下发 terminal.execute 时，其余未授权能力一律不进 Prompt
    ctx = ModelContext(
        taskGoal="查看当前系统负载",
        visibleCapabilities=["terminal.execute"],
        observations=[],
    )
    rendered_executor = render_input(ctx)
    assert "terminal.execute" in rendered_executor
    assert "filesystem.list" not in rendered_executor
    assert "document.extract_pdf" not in rendered_executor

    rendered_planner = render_plan_input("查看当前系统负载", ["terminal.execute"])
    assert "terminal.execute" in rendered_planner
    assert "filesystem.list" not in rendered_planner
