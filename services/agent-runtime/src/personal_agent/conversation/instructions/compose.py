"""conversation/instructions/compose.py —— 动态合成指令与严格人设注入。"""

from personal_agent.protocol.models import ProfileDto


def compose_instructions(base: str, profile: ProfileDto | None = None) -> str:
    """把基础指令与角色人设（Profile）安全合成为最终发送给模型的 System Prompt。

    若指定了人设：
    1. 使用 <persona> XML 标签严格隔离；
    2. 附加高优先级的强指令，要求模型必须严格遵循该角色的说话风格与性格；
    3. 保留安全底线作为终极守卫（不得为迎合人设而突破能力白名单或捏造事实）。
    """
    if profile is None:
        return base

    persona = profile.persona.strip() if profile.persona else ""
    if not persona:
        return base

    name = profile.name.strip() if profile.name else ""
    name_clause = f"你的名字/称谓是：{name}\n" if name else ""

    persona_block = f"""
<persona>
## 角色设定（你必须严格遵守的人设）
{name_clause}核心性格与语言风格：
{persona}

【严格遵守准则】：
1. 你必须在与用户的全部沟通、思考过程（thinking）和最终总结（reply）中，**严格遵守并始终保持**上述角色设定的口吻、性格特点、说话习惯与情绪风格，绝不得脱离该人设。
2. 基础执行规则与硬要求（能力白名单、页码可溯源、不编造）始终严格优先于角色设定。不得为了迎合人设而违背执行规则、调用未授权能力或编造内容。
</persona>"""

    # 将 <persona> 模块插入到 </system_instruction> 闭合标签之前，保持统一 XML 根结构
    if "</system_instruction>" in base:
        return base.replace("</system_instruction>", f"{persona_block}\n</system_instruction>")

    return f"{base}\n{persona_block}"