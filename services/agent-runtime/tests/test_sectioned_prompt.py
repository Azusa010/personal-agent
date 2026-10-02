"""Unit tests for SectionedSystemPrompt (TASK-G1).

Covers XML sectioning, diff patching, KV cache preservation ordering,
validation, and dictionary-like manipulation.
"""

import pytest

from personal_agent.context import (
    DEFAULT_SECTION_ORDER as COMPAT_SECTION_ORDER,
)
from personal_agent.context import (
    SectionedSystemPrompt as CompatSectionedPrompt,
)
from personal_agent.conversation.context import (
    DEFAULT_SECTION_ORDER,
    SectionedSystemPrompt,
)
from personal_agent.conversation.context.sectioned_prompt import (
    SectionedSystemPrompt as DirectSectionedPrompt,
)


def test_sectioned_prompt_imports_and_aliases():
    """验证所有导出路径的一致性与正确性。"""
    assert SectionedSystemPrompt is CompatSectionedPrompt
    assert SectionedSystemPrompt is DirectSectionedPrompt
    assert DEFAULT_SECTION_ORDER == COMPAT_SECTION_ORDER
    assert "preamble" in DEFAULT_SECTION_ORDER
    assert "environment" == DEFAULT_SECTION_ORDER[-1]


def test_section_crud_operations():
    """测试基本增删改查、属性快照与清空。"""
    prompt = SectionedSystemPrompt()
    assert len(prompt) == 0
    assert not prompt.has_section("preamble")
    assert prompt.get_section("preamble") is None
    assert prompt.get_section("preamble", "default_val") == "default_val"

    prompt.set_section("preamble", "You are PersonalAgent.")
    assert len(prompt) == 1
    assert prompt.has_section("preamble")
    assert prompt.get_section("preamble") == "You are PersonalAgent."
    assert prompt.section_names == ["preamble"]
    assert prompt.sections == {"preamble": "You are PersonalAgent."}

    # 修改段落
    prompt.set_section("preamble", "Updated preamble.")
    assert prompt.get_section("preamble") == "Updated preamble."

    # 删除段落
    assert prompt.remove_section("preamble") is True
    assert prompt.remove_section("preamble") is False
    assert len(prompt) == 0
    assert not prompt.has_section("preamble")

    # 批量设置与清空
    prompt.set_sections({"tools": "Tool list", "rules": "Rule list"})
    assert len(prompt) == 2
    prompt.clear()
    assert len(prompt) == 0


def test_section_dict_magic_methods():
    """测试类字典操作（[], in, del, str, repr）。"""
    prompt = SectionedSystemPrompt()
    prompt["preamble"] = "Initial preamble"
    assert "preamble" in prompt
    assert prompt["preamble"] == "Initial preamble"
    assert len(prompt) == 1

    with pytest.raises(KeyError):
        _ = prompt["nonexistent"]

    del prompt["preamble"]
    assert "preamble" not in prompt
    assert len(prompt) == 0

    with pytest.raises(KeyError):
        del prompt["nonexistent"]

    prompt["tools"] = "read, write"
    assert "<tools>" in str(prompt)
    assert "dirty=True" in repr(prompt)


def test_section_name_validation():
    """测试段落标签名称必须合法（符合 XML 命名规范）。"""
    prompt = SectionedSystemPrompt()

    # 合法名称
    valid_names = ["preamble", "tools", "rules_v2", "project-context", "section1"]
    for name in valid_names:
        prompt.set_section(name, "valid content")
        assert prompt.has_section(name)

    # 非法名称
    invalid_names = [
        "",
        "123start_with_digit",
        "<tag>",
        "has space",
        "has.dot",
        "has/slash",
        "has:colon",
    ]
    for name in invalid_names:
        with pytest.raises(ValueError, match="非法段落标签名称"):
            prompt.set_section(name, "content")


def test_section_content_type_validation():
    """测试段落内容必须为字符串类型。"""
    prompt = SectionedSystemPrompt()
    with pytest.raises(TypeError, match="段落内容必须是 str"):
        prompt.set_section("preamble", 12345)  # type: ignore[arg-type]


def test_render_full_basic_formatting():
    """测试全量渲染输出结构与闭合标签。"""
    prompt = SectionedSystemPrompt()
    prompt.set_section("preamble", "You are PersonalAgent, a helpful AI coding assistant.")
    prompt.set_section("tools", "- file_read: read file\n- file_write: write file")

    rendered = prompt.render_full()
    expected = (
        "<preamble>\n"
        "You are PersonalAgent, a helpful AI coding assistant.\n"
        "</preamble>\n\n"
        "<tools>\n"
        "- file_read: read file\n"
        "- file_write: write file\n"
        "</tools>"
    )
    assert rendered == expected
    assert not prompt.is_dirty
    assert prompt.last_rendered == {
        "preamble": "You are PersonalAgent, a helpful AI coding assistant.",
        "tools": "- file_read: read file\n- file_write: write file",
    }


def test_render_diff_initial_and_no_change():
    """测试首次全量渲染后，无修改时 render_diff 返回 None。"""
    prompt = SectionedSystemPrompt()
    prompt.set_section("preamble", "Base instructions")
    prompt.set_section("rules", "Rule 1: Always verify.")

    prompt.render_full()
    assert not prompt.is_dirty
    assert prompt.render_diff() is None
    assert prompt.diff_sections() is None


def test_render_diff_initial_without_render_full():
    """若从未调用 render_full，直接调用 render_diff 视为全部段落为新增。"""
    prompt = SectionedSystemPrompt()
    prompt.set_section("preamble", "Base instructions")
    prompt.set_section("rules", "Rule 1")

    diff = prompt.render_diff()
    assert diff is not None
    assert "<preamble>" in diff
    assert "<rules>" in diff
    assert not prompt.is_dirty
    # 第二次调用无变化返回 None
    assert prompt.render_diff() is None


def test_render_diff_single_and_multiple_modifications():
    """测试仅有部分段落修改时，render_diff 只输出发生变化的段落。"""
    prompt = SectionedSystemPrompt()
    prompt.set_section("preamble", "Static preamble")
    prompt.set_section("tools", "Static tools")
    prompt.set_section("environment", "CWD: /workspace/v1")

    prompt.render_full()

    # 1. 仅环境变化
    prompt.set_section("environment", "CWD: /workspace/v2")
    assert prompt.is_dirty

    patch = prompt.diff_sections()
    assert patch == {"environment": "CWD: /workspace/v2"}

    diff = prompt.render_diff()
    assert diff == "<environment>\nCWD: /workspace/v2\n</environment>"
    assert "<preamble>" not in diff
    assert "<tools>" not in diff
    assert not prompt.is_dirty
    assert prompt.render_diff() is None

    # 2. 多个段落同时变化
    prompt.set_section("tools", "New tool added")
    prompt.set_section("environment", "CWD: /workspace/v3")
    assert prompt.is_dirty

    diff = prompt.render_diff()
    assert "<tools>\nNew tool added\n</tools>" in diff
    assert "<environment>\nCWD: /workspace/v3\n</environment>" in diff
    assert "<preamble>" not in diff
    assert not prompt.is_dirty


def test_render_diff_section_addition_and_deletion():
    """测试新增段落与删除段落的增量输出（删除段落输出墓碑标记）。"""
    prompt = SectionedSystemPrompt()
    prompt.set_section("preamble", "Base instructions")
    prompt.set_section("skills", "Skill A")
    prompt.render_full()

    # 1. 新增段落
    prompt.set_section("project_context", "AGENTS.md instructions")
    diff = prompt.render_diff()
    assert diff == "<project_context>\nAGENTS.md instructions\n</project_context>"

    # 2. 删除段落
    prompt.remove_section("skills")
    assert prompt.is_dirty

    patch = prompt.diff_sections()
    assert patch == {"skills": None}

    diff = prompt.render_diff()
    assert diff == '<skills status="deleted"/>'
    assert not prompt.is_dirty
    assert prompt.render_diff() is None
    assert prompt.render_full() == (
        "<preamble>\nBase instructions\n</preamble>\n\n"
        "<project_context>\nAGENTS.md instructions\n</project_context>"
    )


def test_section_order_cache_first_guarantee():
    """测试 section_order 严格保证静态段在前、动态段在后，优化 KV Cache。"""
    # 故意以逆序设置段落
    raw_sections = {
        "environment": "CWD: /root",
        "skills": "Custom skills",
        "rules": "Safety rules",
        "tools": "Tool definitions",
        "preamble": "You are PersonalAgent",
    }

    # 指定标准顺序
    prompt = SectionedSystemPrompt(
        sections=raw_sections,
        section_order=DEFAULT_SECTION_ORDER,
    )

    rendered = prompt.render_full()
    # 验证顺序：preamble -> tools -> rules -> skills -> environment
    pos_preamble = rendered.find("<preamble>")
    pos_tools = rendered.find("<tools>")
    pos_rules = rendered.find("<rules>")
    pos_skills = rendered.find("<skills>")
    pos_env = rendered.find("<environment>")

    assert 0 <= pos_preamble < pos_tools < pos_rules < pos_skills < pos_env

    # 未包含在 section_order 中的额外段落应排在最后
    prompt.set_section("custom_extra", "Extra details")
    rendered_with_extra = prompt.render_full()
    pos_extra = rendered_with_extra.find("<custom_extra>")
    pos_env_new = rendered_with_extra.find("<environment>")
    assert pos_env_new < pos_extra


def test_clone_and_isolation():
    """测试深拷贝的独立性。"""
    prompt1 = SectionedSystemPrompt(
        sections={"preamble": "Hello"},
        section_order=DEFAULT_SECTION_ORDER,
    )
    prompt1.render_full()

    prompt2 = prompt1.clone()
    assert prompt2.sections == prompt1.sections
    assert prompt2.section_order == prompt1.section_order
    assert not prompt2.is_dirty

    # 修改 prompt2 不影响 prompt1
    prompt2.set_section("preamble", "Modified")
    assert prompt2.is_dirty
    assert not prompt1.is_dirty
    assert prompt1["preamble"] == "Hello"
    assert prompt2["preamble"] == "Modified"


def test_mark_rendered_and_reset_rendered():
    """测试手动标记与重置已渲染记录。"""
    prompt = SectionedSystemPrompt(sections={"tools": "abc"})
    assert prompt.is_dirty

    prompt.mark_rendered()
    assert not prompt.is_dirty
    assert prompt.render_diff() is None

    prompt.reset_rendered()
    assert prompt.is_dirty
    diff = prompt.render_diff()
    assert diff == "<tools>\nabc\n</tools>"


def test_kv_cache_invariant_multi_turn_simulation():
    """模拟多轮交互场景，验证前置静态段始终不产生 diff，仅尾部动态段产生 diff。"""
    prompt = SectionedSystemPrompt(section_order=DEFAULT_SECTION_ORDER)
    prompt.set_section("preamble", "PersonalAgent v1.0")
    prompt.set_section("tools", "read, write, edit, code_interpreter")
    prompt.set_section("rules", "Think with code; Verify before commit.")
    prompt.set_section("skills", "(none)")
    prompt.set_section("environment", "CWD: /project; git: clean")

    # Turn 1: 首次全量发送
    full_prompt = prompt.render_full()
    assert "<preamble>" in full_prompt
    assert "<environment>" in full_prompt
    assert prompt.render_diff() is None

    # Turn 2: 用户执行了 cd，当前工作区改变
    prompt.set_section("environment", "CWD: /project/services; git: clean")
    diff_turn2 = prompt.render_diff()
    assert diff_turn2 == "<environment>\nCWD: /project/services; git: clean\n</environment>"
    # 核心不变量：静态段绝对不出现在 diff 中
    assert "<preamble>" not in diff_turn2
    assert "<tools>" not in diff_turn2
    assert "<rules>" not in diff_turn2

    # Turn 3: 发生了代码修改，git status 变更
    prompt.set_section("environment", "CWD: /project/services; git: 1 modified")
    diff_turn3 = prompt.render_diff()
    assert diff_turn3 == "<environment>\nCWD: /project/services; git: 1 modified\n</environment>"
    assert "<preamble>" not in diff_turn3

    # Turn 4: 固化了新技能
    prompt.set_section("skills", "- log_parser: parse custom logs")
    diff_turn4 = prompt.render_diff()
    assert diff_turn4 == "<skills>\n- log_parser: parse custom logs\n</skills>"
    assert "<preamble>" not in diff_turn4
    assert "<environment>" not in diff_turn4

    # Turn 5: 无任何变化
    assert prompt.render_diff() is None
