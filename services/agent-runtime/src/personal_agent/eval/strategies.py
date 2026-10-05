"""三种记忆机制策略实现 (Memory Strategies)。

基于 SectionedSystemPrompt 与生产级 UserMemoryCard 契约装配上下文：
1. JsonCardsStrategy: 结构化卡片静态常驻系统上下文，无需检索；
2. PureRagStrategy: 无静态记忆卡片，根据提问动态检索历史对话切块；
3. HybridStrategy: 核心记忆卡片常驻 + 动态检索补充原始背景。
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any

from personal_agent.conversation.context import SectionedSystemPrompt
from personal_agent.conversation.sidecar.enricher import (
    CATEGORY_TAG_MAP,
    format_memory_entry,
)
from personal_agent.eval.in_memory_rag import InMemoryRagIndex
from personal_agent.eval.models import MemoryEvalCase, MemoryStrategyType
from personal_agent.protocol.models import UserMemoryCard

EVAL_PREAMBLE = """# 角色定位
你是由 Personal Agent 驱动的个人智能助理，负责依据用户长期记忆与历史对话，准确严谨地回答用户提问。"""

EVAL_RULES = """## 核心执行准则（不可违反）
1. **事实溯源与严禁虚构**：所有的回答、结论与证据必须严格基于上下文中的长期记忆或历史对话检索片段，绝对严禁凭空捏造、推测未经验证的事实（包括但不限于密码、就诊记录、日期、人名、联系方式）。
2. **多实体消歧与澄清**：当问题涉及多个同角色或同类别实体（如双胞胎妹妹、多份邮箱配置）时，必须明确区分各自属性；若提问存在歧义或指代不明，应主动向用户说明实体的区别或追问确认；当记忆中存在同类别多份配置时，回答时应主动指出区别（例如区分工作与个人用途），帮助用户消除歧义。
3. **时效性与版本更替**：当记忆存在新旧更替、冲突或显式取消变更时（如标注了 superseded 或状态已更新），必须优先采纳最新有效记录，并能准确识别行程/计划变更关系。
4. **诚实拒答红线**：若记忆与检索历史中均无相关信息，必须诚实说明不知道，坚决杜绝侥幸猜测或编造伪事实。
5. **严禁主动报菜单**：在回答用户提问时，直接就事论事自然回答，严禁主动罗列或宣传自己具备的能力清单。"""


def format_memory_cards_xml(cards: list[UserMemoryCard | dict[str, Any]]) -> str:
    """将标准 UserMemoryCard 列表格式化为 KV-Cache 友好的 XML 块。"""
    if not cards:
        return "  (无用户记忆卡片)"
    lines = []
    for c in cards:
        if isinstance(c, UserMemoryCard):
            subject = c.subject
            person = c.person or "本人"
            rel = c.relationship or "本人"
            category = c.category
            tag = CATEGORY_TAG_MAP.get(category, category)
            status = "superseded" if c.supersededBy else "active"
            content_str = json.dumps(c.content, ensure_ascii=False)
            formatted_text = format_memory_entry(c)
            attrs = [
                f'category="{tag}"',
                f'subject="{subject}"',
                f'person="{person}"',
                f'relationship="{rel}"',
                f'status="{status}"',
            ]
            if c.supersededBy:
                attrs.append(f'superseded_by="{c.supersededBy}"')
            if c.supersedeReason:
                attrs.append(f'supersede_reason="{c.supersedeReason}"')
            if c.validFrom:
                attrs.append(f'valid_from="{c.validFrom}"')
            attr_str = " ".join(attrs)
            lines.append(f"  <card {attr_str}>")
            lines.append(f"    {formatted_text}")
            lines.append(f"    <!-- data: {content_str} -->")
            lines.append("  </card>")
        else:
            subject = c.get("subject", "通用事实")
            person = c.get("person", "本人")
            rel = c.get("relationship", "本人")
            category = c.get("category", "general")
            tag = CATEGORY_TAG_MAP.get(category, category)
            superseded = c.get("supersededBy")
            status = "superseded" if superseded else "active"
            content_str = json.dumps(c.get("content", {}), ensure_ascii=False)
            formatted_text = format_memory_entry(c)
            attrs = [
                f'category="{tag}"',
                f'subject="{subject}"',
                f'person="{person}"',
                f'relationship="{rel}"',
                f'status="{status}"',
            ]
            if superseded:
                attrs.append(f'superseded_by="{superseded}"')
            if c.get("supersedeReason"):
                attrs.append(f'supersede_reason="{c.get("supersedeReason")}"')
            if c.get("validFrom"):
                attrs.append(f'valid_from="{c.get("validFrom")}"')
            attr_str = " ".join(attrs)
            lines.append(f"  <card {attr_str}>")
            lines.append(f"    {formatted_text}")
            lines.append(f"    <!-- data: {content_str} -->")
            lines.append("  </card>")
    return "\n".join(lines)


def format_retrieved_chunks_xml(chunks: list[Any]) -> str:
    """将检索命中的历史对话切块格式化为 XML 上下文块。"""
    if not chunks:
        return "  (未检索到相关历史对话)"
    lines = []
    for c in chunks:
        lines.append(f'  <dialogue_snippet session="{c.session_idx}">')
        lines.append(f"    {c.text}")
        lines.append("  </dialogue_snippet>")
    return "\n".join(lines)


class BaseMemoryStrategy(ABC):
    """记忆上下文装配基类。"""

    @property
    @abstractmethod
    def strategy_type(self) -> MemoryStrategyType:
        """策略类型标识。"""
        ...

    @abstractmethod
    def assemble_prompt(self, case: MemoryEvalCase, index: InMemoryRagIndex) -> str:
        """为被测用例组装完整的输入提示词（包含记忆注入）。"""
        ...


class JsonCardsStrategy(BaseMemoryStrategy):
    """纯 Advanced JSON Cards 方案：卡片常驻，零动态检索。"""

    @property
    def strategy_type(self) -> MemoryStrategyType:
        return MemoryStrategyType.JSON_CARDS

    def assemble_prompt(self, case: MemoryEvalCase, index: InMemoryRagIndex) -> str:
        prompt = SectionedSystemPrompt(
            section_order=("preamble", "rules", "user_memory", "conversation")
        )
        prompt.set_section("preamble", EVAL_PREAMBLE)
        prompt.set_section("rules", EVAL_RULES)
        if case.memory_cards:
            prompt.set_section(
                "user_memory", format_memory_cards_xml(case.memory_cards)
            )
        prompt.set_section("conversation", f"[当前用户提问]\n{case.question}")
        return prompt.render_full()


class PureRagStrategy(BaseMemoryStrategy):
    """纯 RAG 方案：无预置卡片，通过提问从原始会话切块中按需检索。"""

    @property
    def strategy_type(self) -> MemoryStrategyType:
        return MemoryStrategyType.PURE_RAG

    def assemble_prompt(self, case: MemoryEvalCase, index: InMemoryRagIndex) -> str:
        hits = index.search(case.question, top_k=3)
        prompt = SectionedSystemPrompt(
            section_order=("preamble", "rules", "retrieved_history", "conversation")
        )
        prompt.set_section("preamble", EVAL_PREAMBLE)
        prompt.set_section("rules", EVAL_RULES)
        prompt.set_section("retrieved_history", format_retrieved_chunks_xml(hits))
        prompt.set_section("conversation", f"[当前用户提问]\n{case.question}")
        return prompt.render_full()


class HybridStrategy(BaseMemoryStrategy):
    """混合系统方案：核心事实卡片常驻 + 原始对话按需检索。"""

    @property
    def strategy_type(self) -> MemoryStrategyType:
        return MemoryStrategyType.HYBRID

    def assemble_prompt(self, case: MemoryEvalCase, index: InMemoryRagIndex) -> str:
        hits = index.search(case.question, top_k=3)
        prompt = SectionedSystemPrompt(
            section_order=(
                "preamble",
                "rules",
                "user_memory",
                "retrieved_history",
                "conversation",
            )
        )
        prompt.set_section("preamble", EVAL_PREAMBLE)
        prompt.set_section("rules", EVAL_RULES)
        if case.memory_cards:
            prompt.set_section(
                "user_memory", format_memory_cards_xml(case.memory_cards)
            )
        prompt.set_section("retrieved_history", format_retrieved_chunks_xml(hits))
        prompt.set_section("conversation", f"[当前用户提问]\n{case.question}")
        return prompt.render_full()


def get_strategy(strategy_type: MemoryStrategyType | str) -> BaseMemoryStrategy:
    """根据类型枚举工厂获取对应策略实例。"""
    st = MemoryStrategyType(strategy_type)
    if st == MemoryStrategyType.JSON_CARDS:
        return JsonCardsStrategy()
    elif st == MemoryStrategyType.PURE_RAG:
        return PureRagStrategy()
    elif st == MemoryStrategyType.HYBRID:
        return HybridStrategy()
    raise ValueError(f"未知的记忆策略: {strategy_type}")
