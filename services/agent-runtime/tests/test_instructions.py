"""instructions 模块的规范测试：MD 格式、XML 标签结构、流程驱动 SOP 与人设强约束验证。"""

from personal_agent.conversation.instructions import (
    EXECUTOR_INSTRUCTIONS,
    PLANNER_INSTRUCTIONS,
    compose_instructions,
)
from personal_agent.protocol.models import ProfileDto


def test_instructions_have_xml_and_markdown_structure():
    # 验证执行器与规划器指令均采用 MD + XML 结构
    for prompt in (EXECUTOR_INSTRUCTIONS, PLANNER_INSTRUCTIONS):
        assert "<system_instruction>" in prompt
        assert "</system_instruction>" in prompt
        assert "<rules>" in prompt
        assert "</rules>" in prompt
        assert "<workflow_process>" in prompt
        assert "</workflow_process>" in prompt
        assert "<output_contract>" in prompt
        assert "</output_contract>" in prompt
        # Markdown 标题结构
        assert "# " in prompt or "## " in prompt


def test_instructions_do_not_hardcode_specific_paths_or_capabilities():
    # 保持通用性底线：不写死具体业务目录，确保执行器和规划器无场景偏见
    for prompt in (EXECUTOR_INSTRUCTIONS, PLANNER_INSTRUCTIONS):
        assert "Downloads" not in prompt
        assert "Reading" not in prompt
        assert "filesystem.list" not in prompt
        assert "document.extract_pdf" not in prompt


def test_compose_instructions_injects_persona_with_strict_enforcement():
    profile = ProfileDto(
        name="小智",
        persona="说话幽默，喜欢用括号附带内心吐槽，无论回答什么都要保持幽默管家风格。",
    )

    composed = compose_instructions(EXECUTOR_INSTRUCTIONS, profile)

    # 验证 XML 标签隔离与人设注入
    assert "<persona>" in composed
    assert "</persona>" in composed
    assert "小智" in composed
    assert "幽默管家风格" in composed

    # 验证强调“严格遵守角色人设”的强指令
    assert "严格遵守" in composed or "严格保持" in composed

    # 验证安全与能力底线约束依然作为最高优先级
    assert "能力边界" in composed or "底线" in composed or "事实" in composed


def test_compose_instructions_when_no_persona_omits_tag():
    # 无人设时，不产生悬空的 <persona> 标签，且不发生错误篡改
    profile = ProfileDto(name="助手", persona="")
    composed = compose_instructions(EXECUTOR_INSTRUCTIONS, profile)
    assert "<persona>" not in composed
    assert composed == EXECUTOR_INSTRUCTIONS


def test_instructions_contain_process_driven_workflow_sop():
    # 验证非规则性内容被结构化为流程驱动的决策 SOP (<workflow_process>)
    for prompt in (EXECUTOR_INSTRUCTIONS, PLANNER_INSTRUCTIONS):
        assert "<workflow_process>" in prompt
        assert "</workflow_process>" in prompt

    # 执行器应包含明确的 4 步认知流程（审视现状 -> 对齐计划 -> 决策分支 -> 人设与表达）
    assert "现状" in EXECUTOR_INSTRUCTIONS or "审视" in EXECUTOR_INSTRUCTIONS
    assert "计划" in EXECUTOR_INSTRUCTIONS or "对齐" in EXECUTOR_INSTRUCTIONS
    assert "决策" in EXECUTOR_INSTRUCTIONS or "分支" in EXECUTOR_INSTRUCTIONS
    assert "表达" in EXECUTOR_INSTRUCTIONS or "人设" in EXECUTOR_INSTRUCTIONS


def test_rules_strictly_constrain_inviolable_safety_guardrails():
    # 验证 <rules> 聚焦在宪法级的不可违反守卫（能力白名单、真实路径、事实溯源）
    assert "白名单" in EXECUTOR_INSTRUCTIONS or "能力受限" in EXECUTOR_INSTRUCTIONS
    assert "真实路径" in EXECUTOR_INSTRUCTIONS or "绝对路径" in EXECUTOR_INSTRUCTIONS
    assert "溯源" in EXECUTOR_INSTRUCTIONS or "不编造" in EXECUTOR_INSTRUCTIONS


def test_rules_forbid_mechanically_repeating_capabilities():
    # 验证规则中包含对机械报菜单/背诵能力列表的强约束
    assert "严禁主动复述" in EXECUTOR_INSTRUCTIONS or "报菜单" in EXECUTOR_INSTRUCTIONS


