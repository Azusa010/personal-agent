"""conversation/instructions/compose.py —— 动态合成指令与严格人设注入。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

from personal_agent.protocol.models import ProfileDto

if TYPE_CHECKING:
    from personal_agent.conversation.context.sectioned_prompt import (
        SectionedSystemPrompt,
    )


def build_persona_section_body(profile: ProfileDto | None) -> str | None:
    """提取规范的角色人设主体内容（Markdown 格式，无外层标签）。"""
    if profile is None:
        return None
    persona = profile.persona.strip() if profile.persona else ""
    if not persona:
        return None

    name = profile.name.strip() if profile.name else ""
    name_clause = f"你的名字/称谓是：{name}\n" if name else ""

    return f"""## 角色设定（你必须严格遵守的人设）
{name_clause}核心性格与语言风格：
{persona}

【严格遵守准则】：
1. 你必须在与用户的全部沟通、思考过程（thinking）和最终总结（reply）中，**严格遵守并始终保持**上述角色设定的口吻、性格特点、说话习惯与情绪风格，绝不得脱离该人设。
2. 基础执行规则与硬要求（能力白名单、页码可溯源、不编造）始终严格优先于角色设定。不得为了迎合人设而违背执行规则、调用未授权能力或编造内容。"""


def compose_sectioned_prompt(
    base: SectionedSystemPrompt | Mapping[str, str],
    profile: ProfileDto | None = None,
    order: Sequence[str] | None = None,
) -> SectionedSystemPrompt:
    """基于分段式提示词或段落字典合成包含人设的 SectionedSystemPrompt 实例。"""
    from personal_agent.conversation.context.sectioned_prompt import (
        DEFAULT_SECTION_ORDER,
        SectionedSystemPrompt,
    )

    if isinstance(base, SectionedSystemPrompt):
        prompt = base.clone()
        if order is not None:
            prompt.section_order = order
    else:
        section_order = order or (
            "preamble",
            "tools",
            "rules",
            "workflow_process",
            "output_contract",
            "persona",
            *DEFAULT_SECTION_ORDER[3:],
        )
        prompt = SectionedSystemPrompt(sections=base, section_order=section_order)

    persona_body = build_persona_section_body(profile)
    if persona_body:
        prompt.set_section("persona", persona_body)

    return prompt


def compose_instructions(
    base: str | SectionedSystemPrompt,
    profile: ProfileDto | None = None,
) -> str:
    """把基础指令与角色人设（Profile）安全合成为最终发送给模型的 System Prompt 字符串。

    若输入为 SectionedSystemPrompt，则自动注入 persona 段并返回 render_full()。
    若输入为字符串：
    1. 使用 <persona> XML 标签严格隔离；
    2. 附加高优先级的强指令，要求模型必须严格遵循该角色的说话风格与性格；
    3. 保留安全底线作为终极守卫（不得为迎合人设而突破能力白名单或捏造事实）。
    """
    from personal_agent.conversation.context.sectioned_prompt import (
        SectionedSystemPrompt,
    )

    if isinstance(base, SectionedSystemPrompt):
        return compose_sectioned_prompt(base, profile).render_full()

    persona_body = build_persona_section_body(profile)
    if not persona_body:
        return base

    persona_block = f"""
<persona>
{persona_body}
</persona>"""

    # 将 <persona> 模块插入到 </system_instruction> 闭合标签之前，保持统一 XML 根结构
    if "</system_instruction>" in base:
        return base.replace("</system_instruction>", f"{persona_block}\n</system_instruction>")

    return f"{base}\n{persona_block}"