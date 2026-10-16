"""personal_agent.conversation.dream.llm_consolidator —— 基于大模型的主题做梦归并器。

吸收 Generative Agents / Mem0 记忆做梦与整合前沿机制：
1. 删旧迎新：对比最新提炼的候选事实与既有 Markdown 正文，解决冲突、淘汰过时信息；
2. 语义去重：深度融合相似条目，提炼更加精准、精炼的知识点；
3. 结构优美：保持清晰规范的 Markdown 排版与层级结构，输出纯 Markdown 正文。
"""

import logging
import re
from collections.abc import Callable

from personal_agent.conversation.extractor.models import CandidateMemoryItem
from personal_agent.conversation.model.gateway import (
    ModelContext,
    ModelGateway,
)

log = logging.getLogger(__name__)

DREAM_CONSOLIDATION_SYSTEM_PROMPT = """你是一个顶尖的个人智能体做梦归并（Memory Dreaming & Consolidation）引擎专家。
在做梦（Dream）阶段，你需要对特定分类主题下的旧 Markdown 记忆文档与最新捕获的候选记忆条目进行深度归并与整合。

【归并原则（删旧迎新、去重整合）】：
1. 语义去重与深度融合：
   - 如果新事实与旧文档中某条记录语义相同或重叠，合并为一条表述更精准的知识项，避免简单重复罗列。
2. 删旧迎新与冲突解决：
   - 若新事实与旧记录存在明确冲突或更新（例如旧条目记录“缩进约定使用 4 空格”，新条目要求“统一使用 2 空格”），以最新事实为准，更新或替换旧内容，剔除过时或矛盾的信息。
3. 结构优美与层级清晰：
   - 保持优雅规范的 Markdown 排版，使用一级标题标识主题分类（若既有文档已有标题则继承并保留规范层级），使用清晰的二级小标题或无序列表（- 条目）归纳相关知识点。
4. 严格输出纯 Markdown：
   - 输出完整的最新整合后 Markdown 正文。
   - 严禁包含任何前缀、问候语或解释性对话文本。"""


def create_llm_dream_consolidator(
    model: ModelGateway,
) -> Callable[[str, str, list[CandidateMemoryItem]], str]:
    """创建基于大模型的做梦归并函数。"""

    def consolidate_fn(
        category: str,
        existing_content: str,
        new_items: list[CandidateMemoryItem],
    ) -> str:
        if not new_items:
            return existing_content

        items_str = "\n".join(
            f"- [{item.category or category}] {item.content} (置信度: {item.confidence})"
            for item in new_items
            if item.content
        )

        user_content = (
            f"【主题分类】: {category}\n\n"
            f"【现有 Markdown 文档内容】:\n{existing_content.strip() or '（暂无既有文档，初次建立）'}\n\n"
            f"【本次新增候选记忆条目】:\n{items_str}\n\n"
            "请遵循做梦归并原则，输出整合、去重、解决冲突后的完整 Markdown 文本："
        )

        context = ModelContext(
            taskGoal=f"长期记忆做梦归并: {category}",
            systemPrompt=DREAM_CONSOLIDATION_SYSTEM_PROMPT,
            progressDocument=user_content,
        )

        try:
            decision = model.decide(context)
        except Exception as e:  # noqa: BLE001
            log.warning("做梦归并模型调用异常: %s", e)
            append_lines = [f"- {item.content}" for item in new_items if item.content]
            if existing_content.strip():
                return f"{existing_content.rstrip()}\n\n" + "\n".join(append_lines) + "\n"
            title = f"# {category}\n\n"
            return title + "\n".join(append_lines) + "\n"

        raw_text = getattr(decision, "reply", "")
        if not raw_text and hasattr(decision, "result"):
            raw_text = getattr(decision, "result", "")
        if not raw_text:
            return existing_content

        clean_text = raw_text.strip()
        match = re.match(
            r"^```(?:markdown)?\s*([\s\S]*?)\s*```$", clean_text, re.IGNORECASE
        )
        if match:
            clean_text = match.group(1).strip()

        return clean_text

    return consolidate_fn
