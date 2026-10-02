"""services/agent-runtime/tests/test_sectioned_prompt_bugs.py

针对 SectionedSystemPrompt 模块遗留 Bug 的验收测试集。
覆盖审计报告中标识的：
- Bug 25: calculate_kv_cache_ratio 分母基准计算错误（用 len(prompt2) 计算新请求的命中率）
- Bug 24: render_diff() 已删除段落墓碑标记顺序错乱与死代码
- Bug 23: ContextManager 与 LiveModel 在生产主链路中未集成 SectionedSystemPrompt 孤岛问题
"""

from __future__ import annotations

from unittest.mock import MagicMock

from personal_agent.conversation.context import (
    ContextManager,
    SectionedSystemPrompt,
)
from personal_agent.conversation.model.gateway import ModelContext, Observation
from personal_agent.conversation.model.live_model import (
    LiveModel,
    render_messages,
)
from personal_agent.protocol.models import ProfileDto


# =========================================================================
# Bug 25: calculate_kv_cache_ratio 分母基准
# =========================================================================
def test_calculate_kv_cache_ratio_denominator_basis():
    """Bug 25: 计算 prompt2 相对于 prompt1 的 KV Cache 命中率时，

    分母应为新请求长度 len(prompt2)。
    当 prompt2 追加了大量新内容时，命中率应相应下降，而非虚假汇报 100%。
    """
    prefix = "A" * 100
    prompt1 = prefix
    # prompt2 在前缀基础上追加了 900 字符（总计 1000 字符）
    prompt2 = prefix + ("B" * 900)

    ratio = SectionedSystemPrompt.calculate_kv_cache_ratio(prompt1, prompt2)
    # 命中 100 字符 / 总长 1000 字符 = 0.1 (10%)
    assert ratio == 0.1

    # 两者完全相同时命中率为 1.0 (100%)
    assert SectionedSystemPrompt.calculate_kv_cache_ratio("hello", "hello") == 1.0

    # 空字符串输入安全兜底 0.0
    assert SectionedSystemPrompt.calculate_kv_cache_ratio("", prompt2) == 0.0
    assert SectionedSystemPrompt.calculate_kv_cache_ratio(prompt1, "") == 0.0


# =========================================================================
# Bug 24: render_diff() 墓碑标记顺序与死代码消除
# =========================================================================
def test_render_diff_ordering_and_tombstone_order():
    """Bug 24: render_diff() 中的段落（含新增、修改与被删除的墓碑标记）

    必须严格依照 section_order 排序，绝不得将删除墓碑随意堆砌在末尾。
    """
    prompt = SectionedSystemPrompt(
        section_order=(
            "preamble",
            "tools",
            "rules",
            "skills",
            "project_context",
            "environment",
        )
    )
    prompt.set_section("preamble", "Base preamble")
    prompt.set_section("tools", "Tool definitions")
    prompt.set_section("rules", "Core rules")
    prompt.set_section("skills", "Skill A, Skill B")
    prompt.set_section("environment", "CWD: /workspace; step: 1")
    prompt.render_full()

    # 模拟在下一轮中：
    # 1. 删除前置段落 preamble
    # 2. 删除中间段落 skills
    # 3. 更新尾部段落 environment
    prompt.remove_section("preamble")
    prompt.remove_section("skills")
    prompt.set_section("environment", "CWD: /workspace; step: 2")

    diff = prompt.render_diff()
    assert diff is not None

    pos_preamble = diff.find('<preamble status="deleted"/>')
    pos_skills = diff.find('<skills status="deleted"/>')
    pos_env = diff.find("<environment>")

    # 必须遵循 section_order: preamble (deleted) -> skills (deleted) -> environment (updated)
    assert pos_preamble != -1
    assert pos_skills != -1
    assert pos_env != -1
    assert 0 <= pos_preamble < pos_skills < pos_env

    # 未被修改的静态段不应在 diff 中出现
    assert "<tools>" not in diff
    assert "<rules>" not in diff


# =========================================================================
# Bug 23: ContextManager 与 LiveModel 集成 SectionedSystemPrompt
# =========================================================================
def test_context_manager_integrates_sectioned_system_prompt():
    """Bug 23: ContextManager 必须集成 SectionedSystemPrompt，

    并在 build() 产出的 ModelContext 中提供结构化的 systemPrompt。
    """
    profile = ProfileDto(name="鲁班", persona="精工细作的专家助理")
    cm = ContextManager(profile=profile, task_goal="构建测试用例")

    # 1. 验证 ContextManager 持有 SectionedSystemPrompt 实例且注入了人设
    assert hasattr(cm, "sectioned_prompt")
    assert isinstance(cm.sectioned_prompt, SectionedSystemPrompt)
    assert cm.sectioned_prompt.has_section("preamble")
    assert cm.sectioned_prompt.has_section("persona")
    assert "精工细作" in (cm.sectioned_prompt.get_section("persona") or "")

    # 2. 模拟工具调用与推进
    cm.record(Observation(callId="call-1", capability="file_read", ok=True))
    ctx = cm.build(taskGoal="构建测试用例", visibleCapabilities=["file_read"])

    # 3. ModelContext 必须携带已渲染的 systemPrompt 字段
    assert hasattr(ctx, "systemPrompt")
    assert ctx.systemPrompt is not None
    assert "<preamble>" in ctx.systemPrompt
    assert "<persona>" in ctx.systemPrompt
    assert "精工细作" in ctx.systemPrompt


def test_live_model_uses_context_system_prompt():
    """Bug 23: LiveModel 在 render_messages 与 _decide_responses 时，

    必须优先采用 context.systemPrompt 作为系统提示词。
    """
    custom_system_xml = (
        "<preamble>\nCustom Preamble\n</preamble>\n\n<rules>\nCustom Rules\n</rules>"
    )
    context = ModelContext(
        taskGoal="测试系统提示词接入",
        visibleCapabilities=["file_read"],
        systemPrompt=custom_system_xml,
    )

    # 1. 测试 Chat Completions 消息渲染
    messages = render_messages(context)
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == custom_system_xml

    # 2. 测试 Responses API 请求构建
    model = LiveModel(model="gpt-4o", client=MagicMock(), api_protocol="responses")
    # mock client.responses.create
    mock_response = MagicMock()
    mock_response.output_text = '{"kind": "summary", "reply": "ok", "facts": []}'
    mock_response.usage = None
    model._client_or_create().responses.create.return_value = mock_response

    decision = model.decide(context)
    assert decision.kind == "summary"
    call_kwargs = model._client_or_create().responses.create.call_args.kwargs
    assert call_kwargs["instructions"] == custom_system_xml
