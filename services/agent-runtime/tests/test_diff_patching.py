"""Diff patching 与 KV Cache 保护机制验收测试（TASK-G3）。

验证点：
1. diff_sections() 与 apply_patch() 补丁增删改完整契约；
2. parse_diff_xml() 与 apply_diff_xml() 双向序列化/反序列化；
3. 多轮对话/任务执行中客户端与服务端双向差分状态同步；
4. Cache-First 尾部注入架构在动态环境变化下的 KV Cache 命中率分析与对比；
5. 执行器与规划器真实提示词在多步调度中的增量差分补丁验证。
"""

from personal_agent.conversation.context import (
    DEFAULT_SECTION_ORDER,
    SectionedSystemPrompt,
)
from personal_agent.conversation.instructions import (
    create_executor_sectioned_prompt,
    create_planner_sectioned_prompt,
)
from personal_agent.protocol.models import ProfileDto


def test_diff_patch_application_contract():
    """验证 apply_patch 对新增、更新与删除段落的处理契约。"""
    prompt = SectionedSystemPrompt(section_order=DEFAULT_SECTION_ORDER)
    prompt.set_section("preamble", "Version 1")
    prompt.set_section("tools", "Tool A")
    prompt.mark_rendered()

    # 应用包含新增、修改、删除的补丁
    patch = {
        "preamble": "Version 2",      # 修改
        "tools": None,                # 删除
        "environment": "CWD: /home",  # 新增
    }
    prompt.apply_patch(patch)

    assert prompt["preamble"] == "Version 2"
    assert "tools" not in prompt
    assert prompt["environment"] == "CWD: /home"
    assert prompt.section_names == ["preamble", "environment"]


def test_parse_diff_xml_and_apply_diff_xml():
    """验证 XML 增量文本的解析与重水化（包含墓碑标记）。"""
    xml_diff = """<environment>
- Workspace: D:/repo
- CWD: D:/repo/src
</environment>

<skills status="deleted"/>

<custom_tag>
Some custom multiline
content with <inner>tags</inner>
</custom_tag>"""

    patch = SectionedSystemPrompt.parse_diff_xml(xml_diff)
    assert patch["environment"] == "- Workspace: D:/repo\n- CWD: D:/repo/src"
    assert patch["skills"] is None
    assert patch["custom_tag"] == "Some custom multiline\ncontent with <inner>tags</inner>"

    # 测试通过 apply_diff_xml 更新现有 prompt
    prompt = SectionedSystemPrompt()
    prompt.set_section("skills", "Old skill")
    prompt.set_section("tools", "Read, Write")

    prompt.apply_diff_xml(xml_diff)
    assert "skills" not in prompt
    assert prompt.get_section("skills") is None
    assert prompt["tools"] == "Read, Write"
    assert prompt["environment"] == "- Workspace: D:/repo\n- CWD: D:/repo/src"
    assert "<inner>tags</inner>" in prompt["custom_tag"]


def test_multiturn_replica_synchronization():
    """模拟服务端 Agent 生成 diff，客户端/下游消费方通过 apply_diff_xml 完全同步状态。"""
    server = SectionedSystemPrompt(section_order=DEFAULT_SECTION_ORDER)
    server.set_section("preamble", "You are PersonalAgent.")
    server.set_section("tools", "- file_read\n- file_write")
    server.set_section("rules", "Think before code.")
    server.set_section("environment", "CWD: /workspace; git: clean")

    # Client 通过 Initial Full Render 初始化
    client = SectionedSystemPrompt(section_order=DEFAULT_SECTION_ORDER)
    initial_full = server.render_full()
    # 用解析方式加载初始全量（全量也可视为一组完整 tags）
    client.apply_diff_xml(initial_full)
    assert client.render_full() == server.render_full()

    # Turn 1: 仅环境状态更新（CWD 切换）
    server.set_section("environment", "CWD: /workspace/services; git: clean")
    diff_t1 = server.render_diff()
    assert diff_t1 is not None
    assert "<preamble>" not in diff_t1
    client.apply_diff_xml(diff_t1)
    assert client.render_full() == server.render_full()

    # Turn 2: 固化了新技能沉淀到 .agent/skills/
    server.set_section("skills", "- log_parser: parse custom logs")
    diff_t2 = server.render_diff()
    assert diff_t2 is not None
    client.apply_diff_xml(diff_t2)
    assert client.render_full() == server.render_full()

    # Turn 3: 删除了临时技能
    server.remove_section("skills")
    diff_t3 = server.render_diff()
    assert diff_t3 == '<skills status="deleted"/>'
    client.apply_diff_xml(diff_t3)
    assert client.render_full() == server.render_full()

    # Turn 4: 无任何变化，diff 为 None，不触发网络传输
    diff_t4 = server.render_diff()
    assert diff_t4 is None
    assert client.render_full() == server.render_full()


def test_kv_cache_prefix_hit_ratio_analysis():
    """定量验证 Cache-First 尾部注入模式与头部变动模式的 KV Cache 命中深度。"""
    # 构造真实的静态段与尾部动态段
    static_preamble = "You are PersonalAgent, an autonomous coding agent operating inside a secure workspace."
    static_tools = "- code_interpreter: execute python code in sandbox\n- file_edit: replace file chunks"
    static_rules = "- Never guess file paths\n- Verify deliverables before finish\n- Audit expected values"

    # 1. 采用 Cache-First 顺序（静态段在前，动态 environment 在后）
    cache_friendly = SectionedSystemPrompt(section_order=DEFAULT_SECTION_ORDER)
    cache_friendly.set_section("preamble", static_preamble)
    cache_friendly.set_section("tools", static_tools)
    cache_friendly.set_section("rules", static_rules)
    cache_friendly.set_section("environment", "CWD: /workspace; Step: 1")
    prompt_t1 = cache_friendly.render_full()

    # Step 2: 仅环境推进
    cache_friendly.set_section("environment", "CWD: /workspace; Step: 2; LastOutput: OK")
    prompt_t2 = cache_friendly.render_full()

    # 计算公共前缀长度与命中率
    common_len = SectionedSystemPrompt.calculate_common_prefix_length(prompt_t1, prompt_t2)
    ratio = SectionedSystemPrompt.calculate_kv_cache_ratio(prompt_t1, prompt_t2)

    # 静态段必须完整落在公共前缀内
    assert "<preamble>" in prompt_t1[:common_len]
    assert "<tools>" in prompt_t1[:common_len]
    assert "<rules>" in prompt_t1[:common_len]
    # 理论命中率应极高（通常 > 85%）
    assert ratio >= 0.85
    assert ratio < 1.0

    # 2. 反例对比测试：若将动态 environment 放在最前列
    unfriendly_order = ("environment", "preamble", "tools", "rules")
    unfriendly_prompt1 = SectionedSystemPrompt(section_order=unfriendly_order)
    unfriendly_prompt1.set_section("environment", "CWD: /workspace; Step: 1")
    unfriendly_prompt1.set_section("preamble", static_preamble)
    unfriendly_prompt1.set_section("tools", static_tools)
    unfriendly_prompt1.set_section("rules", static_rules)
    bad_t1 = unfriendly_prompt1.render_full()

    unfriendly_prompt2 = unfriendly_prompt1.clone()
    unfriendly_prompt2.set_section("environment", "CWD: /workspace; Step: 2; LastOutput: OK")
    bad_t2 = unfriendly_prompt2.render_full()

    bad_ratio = SectionedSystemPrompt.calculate_kv_cache_ratio(bad_t1, bad_t2)
    # 因为首段动态内容发生变化，公共前缀瞬间截断在头部，命中率骤降
    assert bad_ratio < 0.20
    assert bad_ratio < ratio


def test_executor_and_planner_live_diff_patching():
    """验证真实执行器与规划器 Sectioned 提示词在多步决策中的差分补丁行为。"""
    profile = ProfileDto(name="鲁班", persona="精益求精的工匠精神，注重代码质量与自愈闭环。")

    # 1. 执行器提示词
    exec_prompt = create_executor_sectioned_prompt(profile)
    rendered_full_exec = exec_prompt.render_full()
    assert "<preamble>" in rendered_full_exec
    assert "<persona>" in rendered_full_exec
    assert exec_prompt.render_diff() is None

    # 模拟环境状态注入到执行器
    exec_prompt.set_section("environment", "- Workspace: D:/app\n- Git Branch: main")
    diff_exec = exec_prompt.render_diff()
    assert diff_exec is not None
    assert diff_exec == "<environment>\n- Workspace: D:/app\n- Git Branch: main\n</environment>"
    # 核心守卫：执行器的 preamble、rules、workflow、persona 绝对不重新发送
    assert "<preamble>" not in diff_exec
    assert "<persona>" not in diff_exec
    assert "<rules>" not in diff_exec

    # 2. 规划器提示词
    plan_prompt = create_planner_sectioned_prompt(profile)
    rendered_full_plan = plan_prompt.render_full()
    assert "<preamble>" in rendered_full_plan
    assert plan_prompt.render_diff() is None

    # 模拟动态技能目录发现注入
    plan_prompt.set_section(
        "skills",
        "<skill><name>yaml-linter</name><desc>lint yaml configs</desc></skill>",
    )
    diff_plan = plan_prompt.render_diff()
    assert diff_plan is not None
    assert "<skills>" in diff_plan
    assert "<preamble>" not in diff_plan
    assert "<rules>" not in diff_plan
