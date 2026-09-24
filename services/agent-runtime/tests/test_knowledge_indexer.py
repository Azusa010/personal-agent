"""知识库端到端入库与全文检索集成测试。"""

import asyncio
from pathlib import Path
from uuid import UUID

from personal_agent.db.postgres import close_pg_pool, get_pg_pool
from personal_agent.knowledge.embedder import MockEmbedder
from personal_agent.knowledge.indexer import KnowledgeIndexer
from personal_agent.knowledge.repository import (
    delete_document,
    get_chunks_by_document_id,
    get_document_by_path,
    search_chunks_fts,
)

FIXTURES_PDF = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "tests"
    / "fixtures"
    / "pdfs"
    / "three-page-text.pdf"
)


def test_indexer_markdown_end_to_end(tmp_path: Path):
    """端到端验证 Markdown 文件解析、分块入库与中文分词 FTS 全文检索。"""

    async def _run():
        pool = await get_pg_pool()
        doc_id = None
        try:
            # 准备测试 Markdown 文档
            sample_file = tmp_path / "agent_theory.md"
            content = """# 人工智能智能体深度理论

## 1. 记忆机制
智能体的长期记忆通常由向量存储与全文检索双重索引支持。
通过混合检索算法可以大幅降低幻觉并提升关键事实召回率。

## 2. 规划能力
通过 ReAct 循环和动态重规划，智能体能够根据环境反馈自主纠错。
"""
            sample_file.write_text(content, encoding="utf-8")

            indexer = KnowledgeIndexer(pool=pool, embedder=MockEmbedder())

            # 1. 首次索引
            res = await indexer.index_file(sample_file)
            assert res.status == "indexed"
            assert res.chunk_count >= 2
            assert res.total_tokens > 0
            doc_id = UUID(res.document_id)

            # 2. 校验 documents 表记录
            doc_record = await get_document_by_path(pool, str(sample_file.resolve()))
            assert doc_record is not None
            assert doc_record["file_name"] == "agent_theory.md"
            assert doc_record["page_count"] == 1

            # 3. 校验 chunks 表记录
            chunks = await get_chunks_by_document_id(pool, doc_id)
            assert len(chunks) == res.chunk_count
            assert any("记忆机制" in (c["heading_path"] or "") for c in chunks)
            # Phase 3: 校验稠密向量与稀疏向量已成功写入
            assert all(c["dense_embedding"] is not None for c in chunks)
            assert all(len(c["dense_embedding"].to_list()) == 1024 for c in chunks)

            # 4. 全文检索 FTS 命中验证 (pg_jieba jiebacfg)
            search_results = await search_chunks_fts(pool, "记忆 & 检索")
            assert len(search_results) > 0
            matching = [r for r in search_results if r["document_id"] == doc_id]
            assert len(matching) > 0
            assert "向量存储与全文检索双重索引" in matching[0]["raw_text"]

            # 5. 幂等性测试：再次索引无变动文件，期望跳过
            res_repeat = await indexer.index_file(sample_file)
            assert res_repeat.status == "skipped_unchanged"
            assert res_repeat.chunk_count == 0

            # 6. 强制更新测试：force=True
            res_forced = await indexer.index_file(sample_file, force=True)
            assert res_forced.status == "updated"
            assert res_forced.chunk_count == res.chunk_count
        finally:
            if doc_id:
                await delete_document(pool, doc_id)
            await close_pg_pool()

    asyncio.run(_run())


def test_indexer_real_pdf_fixture():
    """验证真实 PDF fixture 文件的解析、切分与入库。"""
    assert FIXTURES_PDF.is_file(), f"Fixture PDF 不存在: {FIXTURES_PDF}"

    async def _run():
        pool = await get_pg_pool()
        doc_id = None
        try:
            indexer = KnowledgeIndexer(pool=pool, embedder=MockEmbedder())

            res = await indexer.index_file(FIXTURES_PDF, force=True)
            assert res.status in ["indexed", "updated"]
            assert res.chunk_count > 0
            doc_id = UUID(res.document_id)

            chunks = await get_chunks_by_document_id(pool, doc_id)
            assert len(chunks) > 0

            # 验证能搜到 PDF 里的内容
            search_results = await search_chunks_fts(pool, "PersonalAgent")
            matching = [r for r in search_results if r["document_id"] == doc_id]
            assert len(matching) > 0
        finally:
            if doc_id:
                await delete_document(pool, doc_id)
            await close_pg_pool()

    asyncio.run(_run())
