import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from personal_agent.knowledge import repository
from personal_agent.knowledge.library import KnowledgeLibrary
from personal_agent.knowledge.models import DocumentRecord
from personal_agent.protocol.models import KnowledgeImportParams, KnowledgeSearchParams


def test_auto_search_preserves_viking_when_other_backends_fail(tmp_path, monkeypatch):
    source = tmp_path / "guide.md"
    source.write_text("火星计划预算 120 万元", encoding="utf-8")
    library = KnowledgeLibrary(tmp_path / "store")
    asyncio.run(
        library.import_files(KnowledgeImportParams(paths=[str(source)], mode="viking"))
    )
    pg = SimpleNamespace(search=AsyncMock(side_effect=RuntimeError("数据库离线")))
    monkeypatch.setattr(
        "personal_agent.knowledge.retriever.HybridRetriever", lambda: pg
    )
    result = asyncio.run(library.search(KnowledgeSearchParams(query="火星")))
    assert result.chunks and "120 万元" in result.chunks[0].rawText
    assert "数据库离线" in result.warnings[0]
    with pytest.raises(RuntimeError, match="数据库离线"):
        asyncio.run(
            library.search(KnowledgeSearchParams(query="火星", mode="traditional"))
        )


def test_traditional_never_skips_database_check(tmp_path, monkeypatch):
    source = tmp_path / "guide.txt"
    source.write_text("知识", encoding="utf-8")
    index = AsyncMock(
        return_value=SimpleNamespace(
            document_id="pg-doc", chunk_count=3, status="indexed"
        )
    )
    monkeypatch.setattr(
        "personal_agent.knowledge.library.KnowledgeIndexer",
        lambda: SimpleNamespace(index_file=index),
    )
    library = KnowledgeLibrary(tmp_path / "store")
    params = KnowledgeImportParams(paths=[str(source)], mode="traditional")
    asyncio.run(library.import_files(params))
    index.side_effect = RuntimeError("数据库已不可用")
    assert asyncio.run(library.import_files(params)).entries[0].status == "failed"
    assert index.await_count == 2
    assert library.list_documents().documents[0].chunkCount == 3


def test_replacement_transaction_rolls_back_on_chunk_failure(monkeypatch):
    events = []

    @asynccontextmanager
    async def transaction():
        events.append("begin")
        try:
            yield
        except RuntimeError:
            events.append("rollback")
            raise
        else:
            events.append("commit")

    connection = SimpleNamespace(transaction=transaction, execute=AsyncMock())

    @asynccontextmanager
    async def acquire():
        yield connection

    pool = SimpleNamespace(acquire=acquire)
    upsert = AsyncMock(return_value=uuid4())
    delete = AsyncMock()
    insert = AsyncMock(side_effect=RuntimeError("写入失败"))
    monkeypatch.setattr(repository, "upsert_document", upsert)
    monkeypatch.setattr(repository, "delete_chunks_by_document", delete)
    monkeypatch.setattr(repository, "batch_insert_chunks", insert)
    doc = DocumentRecord(
        source_path="guide.md",
        file_name="guide.md",
        file_type="markdown",
        file_size=1,
        file_hash="abc",
    )
    with pytest.raises(RuntimeError, match="写入失败"):
        asyncio.run(repository.replace_document_chunks(pool, doc, []))
    assert events == ["begin", "rollback"]
    assert upsert.await_args.kwargs["connection"] is connection
    assert delete.await_args.kwargs["connection"] is connection
    assert insert.await_args.kwargs["connection"] is connection
