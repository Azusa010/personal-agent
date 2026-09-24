"""知识库上下文感知检索 (Contextualizer) 单元测试。

验证内容（架构审计对齐版）：
1. 模型与客户端环境变量解析与降级链；
2. 全文上下文分档策略（安全区全量 vs 超长区安全截断）；
3. Anthropic 原版 Prompt 格式（System 挂整篇全文，User 挂目标切块）；
4. DeterministicFallbackContextualizer 确定性前缀生成；
5. LLMContextualizer 异步并发限流 (Semaphore) 与 Fail-Open 弹性降级机制。
"""

import asyncio
from unittest.mock import MagicMock

import pytest

from personal_agent.knowledge.contextualizer import (
    DEFAULT_CONTEXT_MODEL,
    DeterministicFallbackContextualizer,
    LLMContextualizer,
    build_contextual_prompt,
    get_context_client,
    resolve_context_model,
    resolve_document_context_text,
)
from personal_agent.knowledge.models import (
    DocumentChunk,
    FileType,
    ParsedDocument,
)


def test_resolve_context_model(monkeypatch: pytest.MonkeyPatch):
    """测试模型名称解析优先级：OPENAI_CONTEXT_MODEL > OPENAI_MODEL > DEFAULT_CONTEXT_MODEL。"""
    monkeypatch.delenv("OPENAI_CONTEXT_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    assert resolve_context_model() == DEFAULT_CONTEXT_MODEL

    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")
    assert resolve_context_model() == "gpt-4o"

    monkeypatch.setenv("OPENAI_CONTEXT_MODEL", "  claude-3-5-haiku  ")
    assert resolve_context_model() == "claude-3-5-haiku"

    monkeypatch.setenv("OPENAI_CONTEXT_MODEL", "   ")
    assert resolve_context_model() == "gpt-4o"


def test_get_context_client(monkeypatch: pytest.MonkeyPatch):
    """测试客户端解析：无 API Key 时安全返回 None，避免初始化崩溃。"""
    monkeypatch.delenv("OPENAI_CONTEXT_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert get_context_client() is None

    monkeypatch.setenv("OPENAI_CONTEXT_API_KEY", "sk-mock-key-12345")
    client = get_context_client()
    assert client is not None
    assert hasattr(client, "chat")


def test_resolve_document_context_text():
    """测试文档全文解析的分档安全策略（Token 级分档）。"""
    short_content = "# 短文档\n这是正文内容，只有几十字。"
    doc_short = ParsedDocument(
        source_path="/test_short.md",
        file_name="test_short.md",
        file_type=FileType.MARKDOWN,
        markdown=short_content,
        page_count=1,
    )
    # 安全区内 100% 完整返回，不截断
    assert resolve_document_context_text(doc_short) == short_content

    # 超长文档（设置小阈值 max_tokens=20 测试截断分支）
    long_content = "This is a repeated sentence for testing token truncation in document context. " * 10
    doc_long = ParsedDocument(
        source_path="/test_long.md",
        file_name="test_long.md",
        file_type=FileType.MARKDOWN,
        markdown=long_content,
        page_count=5,
    )
    result = resolve_document_context_text(doc_long, max_tokens=20)
    assert "...[文档超长，已截断安全上下文]" in result
    assert result.startswith("This is a repeated sentence")


def test_build_contextual_prompt():
    """测试装配符合 Anthropic 原版规范的提示词格式（静态全文 + 动态切块）。"""
    doc_title = "ACME 2025 战略规划.md"
    full_doc_text = """# ACME 智能科技集团 2025 战略规划

ACME 科技致力于下一代个人智能体研发。
...
第 8 页定义：项目 Titan 为下一代自主智能体系统。
...
第 15 页：该项目的二期工程将在第四季度启动。
"""
    heading = "第3章/3.2节/项目进度"
    chunk_text = "该项目的二期工程将在第四季度启动，预计带来显著技术突破。"

    messages = build_contextual_prompt(
        document_title=doc_title,
        document_text=full_doc_text,
        heading_path=heading,
        chunk_raw_text=chunk_text,
    )

    assert isinstance(messages, list)
    assert len(messages) == 2
    system_msg, user_msg = messages[0], messages[1]

    # System 消息作为静态前缀，应完整包含文档标题与全文内容（支持 Prompt Caching）
    assert system_msg["role"] == "system"
    assert "<document>" in system_msg["content"]
    assert f"Title: {doc_title}" in system_msg["content"]
    assert full_doc_text in system_msg["content"]

    # User 消息作为动态切块，包含切块与简短指示
    assert user_msg["role"] == "user"
    assert "<chunk>" in user_msg["content"]
    assert chunk_text in user_msg["content"]
    assert "<heading_path>第3章/3.2节/项目进度</heading_path>" in user_msg["content"]


def test_deterministic_fallback_contextualizer():
    """测试确定性兜底前缀生成器。"""
    fallback = DeterministicFallbackContextualizer()
    prefix = fallback.generate_prefix(
        file_name="annual_report.pdf",
        heading_path="财务摘要/营收分析",
        page_numbers=[3, 4],
    )
    assert prefix == "[文档: annual_report.pdf | 章节: 财务摘要/营收分析 | 页码: P3,4]"

    chunks = [
        DocumentChunk(
            chunk_index=0,
            page_numbers=[1],
            heading_path="简介",
            raw_text="正文段落1",
            token_count=10,
        ),
        DocumentChunk(
            chunk_index=1,
            page_numbers=[2],
            heading_path=None,
            raw_text="正文段落2",
            token_count=10,
            context_prefix="[已有前缀]",
        ),
    ]
    doc = ParsedDocument(
        source_path="/test.pdf",
        file_name="test.pdf",
        file_type=FileType.PDF,
        markdown="content",
        page_count=2,
    )

    asyncio.run(fallback.contextualize_chunks(doc, chunks))
    assert "[文档: test.pdf | 章节: 简介 | 页码: P1]" in chunks[0].context_prefix
    assert chunks[1].context_prefix == "[已有前缀]"  # 不覆盖已有前缀


def test_contextualize_chunks_concurrency_and_fallback():
    """测试 LLMContextualizer 的并发控制 (Semaphore)、重试与 Fail-Open 降级逻辑。"""
    max_concurrency = 3
    current_concurrent = 0
    max_observed_concurrent = 0
    lock = asyncio.Lock()

    class MockChatCompletions:
        def create(self, model: str, messages: list[dict[str, str]], **kwargs):
            nonlocal current_concurrent, max_observed_concurrent
            user_content = messages[1]["content"]

            async def _track():
                nonlocal current_concurrent, max_observed_concurrent
                async with lock:
                    current_concurrent += 1
                    max_observed_concurrent = max(max_observed_concurrent, current_concurrent)
                await asyncio.sleep(0.05)
                async with lock:
                    current_concurrent -= 1

            asyncio.run(_track())

            if "ERROR_TRIGGER" in user_content:
                raise ConnectionError("Simulated LLM API Timeout or 429 Rate Limit")

            resp_mock = MagicMock()
            resp_mock.choices = [
                MagicMock(
                    message=MagicMock(
                        content="[Titan 项目] 本切块讨论 Titan 智能体二期工程进度。"
                    )
                )
            ]
            return resp_mock

    mock_client = MagicMock()
    mock_client.chat.completions = MockChatCompletions()

    contextualizer = LLMContextualizer(
        client=mock_client,
        max_concurrency=max_concurrency,
        max_retries=2,  # 缩短测试耗时
    )

    chunks = [
        DocumentChunk(
            chunk_index=0,
            page_numbers=[1],
            heading_path="章节1",
            raw_text="正常切块内容 1",
            token_count=10,
        ),
        DocumentChunk(
            chunk_index=1,
            page_numbers=[1],
            heading_path="章节2",
            raw_text="包含 ERROR_TRIGGER 的故障切块",
            token_count=10,
        ),
        DocumentChunk(
            chunk_index=2,
            page_numbers=[2],
            heading_path="章节3",
            raw_text="正常切块内容 3",
            token_count=10,
        ),
        DocumentChunk(
            chunk_index=3,
            page_numbers=[2],
            heading_path="章节4",
            raw_text="正常切块内容 4",
            token_count=10,
        ),
    ]

    doc = ParsedDocument(
        source_path="/test_doc.md",
        file_name="test_doc.md",
        file_type=FileType.MARKDOWN,
        markdown="# 全局标题\n第8页定义了 Titan 项目。\n第15页该项目进入二期。",
        page_count=2,
    )

    result_chunks = asyncio.run(contextualizer.contextualize_chunks(doc, chunks))
    assert len(result_chunks) == 4

    # 1. 验证并发限流：最大瞬时并发调用不得超过 max_concurrency
    assert max_observed_concurrent <= max_concurrency

    # 2. 正常切块获得 LLM 生成的精准指代前缀
    assert result_chunks[0].context_prefix == "[Titan 项目] 本切块讨论 Titan 智能体二期工程进度。"
    assert result_chunks[2].context_prefix == "[Titan 项目] 本切块讨论 Titan 智能体二期工程进度。"
    assert result_chunks[3].context_prefix == "[Titan 项目] 本切块讨论 Titan 智能体二期工程进度。"

    # 3. 故障切块重试耗尽后平滑降级为规则前缀，入库不中断 (Fail-Open)
    assert "[文档: test_doc.md | 章节: 章节2 | 页码: P1]" in result_chunks[1].context_prefix

    # 4. 验证 augmented_text 属性正常拼接
    assert "[Titan 项目]" in result_chunks[0].augmented_text
    assert "正常切块内容 1" in result_chunks[0].augmented_text
