"""上下文感知检索前缀生成器 (Contextual Retrieval)。

基于 Anthropic 方案：在分块后、向量化前，利用大模型为每个切块生成 1-2 句包含
全局文档与章节背景的前缀摘要，从而消除切块的语义孤岛（指代不清、时间缺失、主题丢失）。

设计原则（架构审计版）：
1. 静态区传入完整文档正文（Whole Document），最大化利用 Prompt Caching，彻底解决跨页长距离指代消歧；
2. 引入文档长度分档阈值（< 10 万字全量输入，超长文件平滑安全截断）；
3. 指数退避重试（最多 3 次）配合 Fail-Open 兜底，防止网络瞬时抖动导致前缀质量退化。
"""

from __future__ import annotations

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from typing import Any

import tiktoken

from personal_agent.knowledge.models import DocumentChunk, ParsedDocument

log = logging.getLogger("personal_agent")

CONTEXT_MODEL_ENV = "OPENAI_CONTEXT_MODEL"
DEFAULT_CONTEXT_MODEL = "gpt-4o-mini"
MAX_DOCUMENT_CONTEXT_TOKENS = 100_000


def resolve_context_model() -> str:
    """解析上下文前缀生成所使用的模型名称。

    契约规范：
    - 优先级体系：
      1. 若配置了环境变量 OPENAI_CONTEXT_MODEL 且非空白字符，优先使用；
      2. 否则若配置了 OPENAI_MODEL 且非空白字符，降级读取；
      3. 若均未配置或纯空白，保底返回 DEFAULT_CONTEXT_MODEL ('gpt-4o-mini')；
    - 边界处理：两端空白需自动 trim()。
    - 对应验收测试：tests/test_knowledge_contextualizer.py::test_resolve_context_model
    """
    ctx_model = (os.getenv(CONTEXT_MODEL_ENV) or "").strip()
    if ctx_model:
        return ctx_model
    openai_model = (os.getenv("OPENAI_MODEL") or "").strip()
    if openai_model:
        return openai_model
    return DEFAULT_CONTEXT_MODEL


def get_context_client() -> Any | None:
    """创建并返回 OpenAI 兼容客户端实例。

    契约规范：
    - 读取 API Key：优先 OPENAI_CONTEXT_API_KEY，次选 OPENAI_API_KEY。若均为空，直接返回 None（不抛异常，走后续兜底）；
    - 读取 Base URL：优先 OPENAI_CONTEXT_BASE_URL，次选 OPENAI_BASE_URL；
    - 实例化：使用 openai.OpenAI(api_key=..., base_url=...)，如果发生异常捕获并记录 warning 日志，返回 None；
    - 对应验收测试：tests/test_knowledge_contextualizer.py::test_get_context_client
    """
    try:
        import openai
    except ImportError:
        log.warning("未安装 openai 库，无法创建上下文客户端")
        return None

    api_key = os.getenv("OPENAI_CONTEXT_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        log.warning(
            "未配置 OPENAI_CONTEXT_API_KEY 或 OPENAI_API_KEY，无法创建上下文客户端"
        )
        return None

    base_url = os.getenv("OPENAI_CONTEXT_BASE_URL") or os.getenv("OPENAI_BASE_URL")

    try:
        client = openai.OpenAI(api_key=api_key, base_url=base_url)
        return client
    except Exception as e:  # noqa: BLE001
        log.warning(f"创建上下文客户端失败: {e}")
        return None


def resolve_document_context_text(
    parsed_doc: ParsedDocument,
    max_tokens: int = MAX_DOCUMENT_CONTEXT_TOKENS,
) -> str:
    """解析文档全局上下文正文，落实安全分档策略（基于 Token 数量切分）。

    契约规范：
    - 输入：ParsedDocument 对象，max_tokens 阈值（默认 100,000 tokens）；
    - 若 len(tokens) <= max_tokens：100% 完整返回 parsed_doc.markdown，
      以触发长文本 Prompt Caching 并支持跨页面任意距离指代消歧；
    - 若超出 max_tokens：截取前 max_tokens 个 token 解码并附加 "\n\n...[文档超长，已截断安全上下文]"；
    - 对应验收测试：tests/test_knowledge_contextualizer.py::test_resolve_document_context_text
    """
    encoding = tiktoken.get_encoding("cl100k_base")
    tokens = encoding.encode(parsed_doc.markdown)
    if len(tokens) <= max_tokens:
        return parsed_doc.markdown

    truncated_tokens = tokens[:max_tokens]
    truncated_text = encoding.decode(truncated_tokens)
    return f"{truncated_text}\n\n...[文档超长，已截断安全上下文]"


def build_contextual_prompt(
    document_title: str,
    document_text: str,
    heading_path: str | None,
    chunk_raw_text: str,
) -> list[dict[str, str]]:
    """装配严格遵循 Anthropic 规范的双段式上下文生成提示词。
    """
    messages: list[dict[str, str]] = []
    system_content = f"""<document>
Title: {document_title}
Content:{document_text}
</document>"""
    messages.append({"role": "system", "content": system_content})
    user_content = f"""
以下是我们想要置于整个文档中的片段：
<heading_path>{heading_path or "正文"}</heading_path>
<chunk>
{chunk_raw_text}
</chunk>

请提供一个简短精炼的上下文（1-2句话），将该片段置于整体文档中，以便提升该片段的搜索检索效果。只回答这个简洁上下文，不要其他内容。
"""
    messages.append({"role": "user", "content": user_content})
    return messages


# ==============================================================================
# 上下文感知生成器接口与类定义
# ==============================================================================
class BaseContextualizer(ABC):
    """上下文感知生成器基类。"""

    @abstractmethod
    async def contextualize_chunks(
        self,
        parsed_doc: ParsedDocument,
        chunks: list[DocumentChunk],
    ) -> list[DocumentChunk]:
        """批量为切块注入上下文前缀 (context_prefix)。"""


class DeterministicFallbackContextualizer(BaseContextualizer):
    """基于元数据的确定性纯规则前缀生成器（零开销、零网络依赖保底）。"""

    def generate_prefix(
        self,
        file_name: str,
        heading_path: str | None,
        page_numbers: list[int] | None = None,
    ) -> str:
        """根据元数据生成结构化确定性前缀。"""
        parts = [f"文档: {file_name}"]
        if heading_path:
            parts.append(f"章节: {heading_path}")
        if page_numbers:
            pages_str = ",".join(str(p) for p in page_numbers)
            parts.append(f"页码: P{pages_str}")
        return f"[{' | '.join(parts)}]"

    async def contextualize_chunks(
        self,
        parsed_doc: ParsedDocument,
        chunks: list[DocumentChunk],
    ) -> list[DocumentChunk]:
        """为所有切块赋予确定性规则前缀。"""
        for chunk in chunks:
            if not chunk.context_prefix:
                chunk.context_prefix = self.generate_prefix(
                    file_name=parsed_doc.file_name,
                    heading_path=chunk.heading_path,
                    page_numbers=chunk.page_numbers,
                )
        return chunks


class MockContextualizer(BaseContextualizer):
    """单测与 CI 专用 Mock 生成器，稳定返回注入特定测试实体的上下文。"""

    def __init__(
        self, prefix_template: str = "[测试上下文: {file_name} - {heading_path}]"
    ):
        self.prefix_template = prefix_template

    async def contextualize_chunks(
        self,
        parsed_doc: ParsedDocument,
        chunks: list[DocumentChunk],
    ) -> list[DocumentChunk]:
        for chunk in chunks:
            chunk.context_prefix = self.prefix_template.format(
                file_name=parsed_doc.file_name,
                heading_path=chunk.heading_path or "未命名章节",
            )
        return chunks


class LLMContextualizer(BaseContextualizer):
    """基于 LLM 的上下文前缀生成器（带 Prompt Caching、指数退避重试与并发保护）。"""

    def __init__(
        self,
        model: str | None = None,
        client: Any | None = None,
        max_concurrency: int = 5,
        fallback: BaseContextualizer | None = None,
        max_retries: int = 3,
    ) -> None:
        self.model = model or resolve_context_model()
        self.client = client
        self.max_concurrency = max_concurrency
        self.max_retries = max_retries
        self.fallback = fallback or DeterministicFallbackContextualizer()
        self._semaphore = asyncio.Semaphore(max_concurrency)

    def _get_client(self) -> Any | None:
        if self.client is not None:
            return self.client
        self.client = get_context_client()
        return self.client

    async def _generate_single_chunk_prefix(
        self,
        client: Any,
        prompt_messages: list[dict[str, str]],
    ) -> str:
        """带指数退避重试的单块前缀生成。

        契约规范：
        1. 限制 max_tokens=120，temperature=0.0，避免前缀冗长喧宾夺主；
        2. 重试机制：最多尝试 self.max_retries 次（默认 3 次）。
           若调用发生异常（如网络波动/429 限流），每次失败后 sleep (0.2 * 2**attempt) 秒后重试；
        3. 若重试全部耗尽仍抛异常，向上抛出，由外层调用者触发 Fail-Open 降级。
        """
        loop = asyncio.get_running_loop()

        def _call_api() -> str:
            last_err: Exception | None = None
            for attempt in range(self.max_retries):
                try:
                    resp = client.chat.completions.create(
                        model=self.model,
                        messages=prompt_messages,
                        temperature=0.0,
                        max_tokens=120,
                    )
                    return resp.choices[0].message.content.strip()
                except Exception as err:  # noqa: BLE001
                    last_err = err
                    if attempt < self.max_retries - 1:
                        import time

                        time.sleep(0.1 * (2**attempt))
            if last_err:
                raise last_err
            raise RuntimeError("LLM 调用重试失败")

        return await loop.run_in_executor(None, _call_api)

    async def contextualize_chunks(
        self,
        parsed_doc: ParsedDocument,
        chunks: list[DocumentChunk],
    ) -> list[DocumentChunk]:
        """批量为切块注入上下文前缀。
        """
        client = self._get_client()
        if client is None:
            log.warning(
                "未获取到上下文客户端，降级为 DeterministicFallbackContextualizer"
            )
            return await self.fallback.contextualize_chunks(parsed_doc, chunks)

        doc_text = resolve_document_context_text(parsed_doc)

        async def process_chunk(chunk: DocumentChunk) -> None:
            async with self._semaphore:
                prompt_messages = build_contextual_prompt(
                    document_title=parsed_doc.file_name,
                    document_text=doc_text,
                    heading_path=chunk.heading_path,
                    chunk_raw_text=chunk.raw_text,
                )
                try:
                    prefix = await self._generate_single_chunk_prefix(
                        client, prompt_messages
                    )
                    chunk.context_prefix = prefix
                except Exception as e:
                    log.warning(
                        f"LLM 前缀生成失败，使用规则前缀降级处理: {e}", exc_info=True
                    )
                    chunk.context_prefix = self.fallback.generate_prefix(
                        file_name=parsed_doc.file_name,
                        heading_path=chunk.heading_path,
                        page_numbers=chunk.page_numbers,
                    )

        await asyncio.gather(*(process_chunk(chunk) for chunk in chunks))
        return chunks


def get_default_contextualizer() -> BaseContextualizer:
    """获取默认上下文生成器工厂：若未配置 API Key 则优雅降级为规则前缀。"""
    client = get_context_client()
    if client is not None:
        return LLMContextualizer(client=client)
    return DeterministicFallbackContextualizer()
