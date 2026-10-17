from pathlib import Path

from personal_agent.conversation.subagent.catalog import (
    EXPLORE_SYSTEM_PROMPT,
    GENERAL_SYSTEM_PROMPT,
    PLAN_SYSTEM_PROMPT,
    READONLY_BASE_TOOLS,
    create_default_prototypes,
)
from personal_agent.conversation.subagent.pool import SubagentPool
from personal_agent.conversation.subagent.prototype import SubagentPrototype


def test_create_default_prototypes_structure():
    """验证 create_default_prototypes() 返回包含 explore, plan, general 三大母体的字典。"""
    prototypes = create_default_prototypes()

    assert isinstance(prototypes, dict)
    assert set(prototypes.keys()) == {"explore", "plan", "general"}
    for proto in prototypes.values():
        assert isinstance(proto, SubagentPrototype)


def test_explore_prototype_spec():
    """验证 explore 母体具备严格只读约束与代码勘探专用工具集。"""
    prototypes = create_default_prototypes()
    explore_proto = prototypes["explore"]

    # 验证提示词只读约束与 SOTA 勘探契约
    assert "CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS" in explore_proto.system_prompt
    assert "FORBIDDEN from creating, modifying, editing, moving, or deleting" in explore_proto.system_prompt
    assert "file_search, file_read, and filesystem_list" in explore_proto.system_prompt
    assert explore_proto.system_prompt == EXPLORE_SYSTEM_PROMPT

    # 验证只读基础工具
    tool_names = [tool["name"] for tool in explore_proto.base_tools]
    assert tool_names == ["file_read", "file_search", "filesystem_list"]
    assert explore_proto.base_tools == READONLY_BASE_TOOLS


def test_plan_prototype_spec():
    """验证 plan 母体具备三阶段规划范式与架构蓝图提示词。"""
    prototypes = create_default_prototypes()
    plan_proto = prototypes["plan"]

    # 验证提示词规划范式
    assert "CRITICAL: READ-ONLY MODE" in plan_proto.system_prompt
    assert "THREE-PHASE PLANNING PARADIGM" in plan_proto.system_prompt
    assert "Requirements & Caller Analysis" in plan_proto.system_prompt
    assert "Codebase Survey & Dependency Mapping" in plan_proto.system_prompt
    assert "Structured Blueprint Formulation" in plan_proto.system_prompt
    assert plan_proto.system_prompt == PLAN_SYSTEM_PROMPT

    # 验证基础工具同样限定为只读
    tool_names = [tool["name"] for tool in plan_proto.base_tools]
    assert tool_names == ["file_read", "file_search", "filesystem_list"]
    assert plan_proto.base_tools == READONLY_BASE_TOOLS


def test_general_prototype_spec():
    """验证 general 母体具备通用自主执行与上下文隔离回灌提示词，且工具池开放。"""
    prototypes = create_default_prototypes()
    general_proto = prototypes["general"]

    assert "General Autonomous Execution Subagent" in general_proto.system_prompt
    assert "Autonomous Problem Solving" in general_proto.system_prompt
    assert "Distilled Synthesis" in general_proto.system_prompt
    assert general_proto.system_prompt == GENERAL_SYSTEM_PROMPT
    assert general_proto.base_tools == []


def test_default_traces_dir_propagation(tmp_path: Path):
    """验证 default_traces_dir 能正确传播给所有初始化的母体。"""
    custom_traces = tmp_path / "custom_subagent_traces"
    prototypes = create_default_prototypes(default_traces_dir=custom_traces)

    for proto in prototypes.values():
        assert proto.default_traces_dir == custom_traces


def test_subagent_pool_spawn_with_catalog_prototypes(tmp_path: Path):
    """验证 SubagentPool 接入母体库后，能按名称生成特定子智能体实例并继承工具与提示词。"""
    traces_dir = tmp_path / "subagent_traces"
    prototypes = create_default_prototypes(default_traces_dir=traces_dir)
    pool = SubagentPool(prototypes=prototypes)

    # 1. 验证 spawn 'explore'
    instance_explore = pool.spawn(
        role="RepoScout",
        goal="Locate all database migration files",
        prototype="explore",
    )
    assert instance_explore.role == "RepoScout"
    assert instance_explore.goal == "Locate all database migration files"
    assert "CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS" in instance_explore.system_prompt
    assert "RepoScout" in instance_explore.system_prompt
    assert "Locate all database migration files" in instance_explore.system_prompt
    assert [t["name"] for t in instance_explore.tools] == ["file_read", "file_search", "filesystem_list"]
    assert instance_explore.isolator.trace_file.parent == traces_dir

    # 2. 验证 spawn 'plan'
    instance_plan = pool.spawn(
        role="SystemArchitect",
        goal="Design caching and eviction strategy",
        prototype="plan",
    )
    assert instance_plan.role == "SystemArchitect"
    assert instance_plan.goal == "Design caching and eviction strategy"
    assert "THREE-PHASE PLANNING PARADIGM" in instance_plan.system_prompt
    assert [t["name"] for t in instance_plan.tools] == ["file_read", "file_search", "filesystem_list"]

    # 3. 验证 spawn 'general' (默认母体)
    instance_general = pool.spawn(
        role="TaskExecutor",
        goal="Perform end-to-end task execution",
        prototype="general",
    )
    assert instance_general.role == "TaskExecutor"
    assert "General Autonomous Execution Subagent" in instance_general.system_prompt
    assert instance_general.tools == []

    # 4. 验证 allowed_tools 对只读工具集的二次过滤
    instance_filtered = pool.spawn(
        role="QuickInspector",
        goal="Read single config file",
        prototype="explore",
        allowed_tools=["file_read"],
    )
    assert [t["name"] for t in instance_filtered.tools] == ["file_read"]

    # 5. 验证未知 prototype 自动回退至 default_prototype (general)
    instance_fallback = pool.spawn(
        role="FallbackWorker",
        goal="Test fallback",
        prototype="non_existent_type",
    )
    assert "General Autonomous Execution Subagent" in instance_fallback.system_prompt
