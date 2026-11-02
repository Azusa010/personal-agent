import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from personal_agent.knowledge.library import KnowledgeLibrary, terms
from personal_agent.protocol.models import (
    KnowledgeImportParams,
    KnowledgeImportResult,
    KnowledgeListResult,
    KnowledgeSearchParams,
    KnowledgeSearchResult,
)


def test_shared_fixture():
    fixture = json.loads(
        (
            Path(__file__).parents[3]
            / "packages/protocol/fixtures/knowledge-library.json"
        ).read_text(encoding="utf-8")
    )
    for key, model in [
        ("importParams", KnowledgeImportParams),
        ("importResult", KnowledgeImportResult),
        ("listResult", KnowledgeListResult),
        ("searchParams", KnowledgeSearchParams),
        ("searchResult", KnowledgeSearchResult),
    ]:
        assert (
            model.model_validate(fixture[key]).model_dump(exclude_none=True).items()
            >= fixture[key].items()
        )


def test_viking_import_search_restart_and_update(tmp_path):
    source = tmp_path / "guide.md"
    source.write_text(
        "# 知识库\n\n火星计划预算 120 万元，负责人张三。", encoding="utf-8"
    )
    root = tmp_path / "store"
    library = KnowledgeLibrary(root)
    params = KnowledgeImportParams(paths=[str(source)], mode="viking")
    first = asyncio.run(library.import_files(params))
    assert first.entries[0].status == "indexed"
    assert first.entries[0].chunkCount > 0
    assert (
        asyncio.run(library.import_files(params)).entries[0].status
        == "skipped_unchanged"
    )
    library = KnowledgeLibrary(root)
    doc = library.list_documents().documents[0]
    result = asyncio.run(
        library.search(KnowledgeSearchParams(query="火星计划", mode="viking"))
    )
    assert result.chunks and "120 万元" in result.chunks[0].rawText
    assert result.chunks[0].sourcePath == str(source.resolve())
    assert not asyncio.run(
        library.search(
            KnowledgeSearchParams(query="火星", mode="viking", documentIds=[])
        )
    ).chunks
    assert not asyncio.run(
        library.search(
            KnowledgeSearchParams(query="火星", mode="viking", fileTypes=["pdf"])
        )
    ).chunks
    assert not asyncio.run(
        library.search(KnowledgeSearchParams(query="火星", mode="viking", minScore=2))
    ).chunks
    bundles = list((root / "knowledge/imports").glob("*/INDEX.md"))
    assert bundles and "120 万元" in bundles[0].read_text(encoding="utf-8")
    assert bundles[0].with_name(".abstract.md").exists()
    assert bundles[0].with_name(".overview.md").exists()
    source.write_text("火星计划预算改为 200 万元。", encoding="utf-8")
    assert asyncio.run(library.import_files(params)).entries[0].status == "updated"
    assert library.list_documents().documents[0].id == doc.id
    assert (
        "200 万元"
        in asyncio.run(
            library.search(KnowledgeSearchParams(query="火星", mode="viking"))
        )
        .chunks[0]
        .rawText
    )
    assert (
        asyncio.run(library.import_files(params.model_copy(update={"force": True})))
        .entries[0]
        .status
        == "updated"
    )


def test_batch_failure_isolation_and_empty_document(tmp_path):
    good, empty = tmp_path / "good.txt", tmp_path / "empty.txt"
    good.write_text("可检索知识", encoding="utf-8")
    empty.write_text("   ", encoding="utf-8")
    library = KnowledgeLibrary(tmp_path / "store")
    result = asyncio.run(
        library.import_files(
            KnowledgeImportParams(
                paths=[str(tmp_path / "missing.txt"), str(good), str(empty)],
                mode="viking",
            )
        )
    )
    assert [e.status for e in result.entries] == ["failed", "indexed", "failed"]
    assert result.entries[0].message
    assert len(library.list_documents().documents) == 1
    with pytest.raises(ValueError, match="不能为空"):
        asyncio.run(library.search(KnowledgeSearchParams(query=" ", mode="viking")))


def test_raptor_build_search_and_failed_rebuild_preserves_old(tmp_path, monkeypatch):
    source = tmp_path / "guide.md"
    source.write_text(("# 项目\n\n火星计划预算 120 万元。\n\n" * 100), encoding="utf-8")
    embedder = SimpleNamespace(
        embed_documents=AsyncMock(
            side_effect=lambda texts: [SimpleNamespace(dense=[1.0, 0.0]) for _ in texts]
        ),
        embed_query=AsyncMock(return_value=SimpleNamespace(dense=[1.0, 0.0])),
    )
    summary = AsyncMock(return_value="火星计划预算总览")
    monkeypatch.setattr(
        "personal_agent.knowledge.library.get_embedder", lambda: embedder
    )
    monkeypatch.setattr("personal_agent.knowledge.library.summarize", summary)
    library = KnowledgeLibrary(tmp_path / "store")
    params = KnowledgeImportParams(paths=[str(source)], mode="raptor")
    assert asyncio.run(library.import_files(params)).entries[0].status == "indexed"
    assert summary.await_count > 0
    record = library._records()[0]
    assert record["tree"]["layers"] > 1
    result = asyncio.run(
        library.search(KnowledgeSearchParams(query="火星", mode="raptor", topK=50))
    )
    assert any(
        c.headingPath and c.headingPath.startswith("RAPTOR L") for c in result.chunks
    )
    assert all(c.fileName == "guide.md" for c in result.chunks)
    summary.side_effect = RuntimeError("模型不可用")
    failed = asyncio.run(
        library.import_files(params.model_copy(update={"force": True}))
    )
    assert failed.entries[0].status == "failed"
    assert "模型不可用" in failed.entries[0].message
    assert library._records() == [record]


def test_traditional_delegates_to_existing_indexer(tmp_path, monkeypatch):
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
    result = asyncio.run(
        library.import_files(
            KnowledgeImportParams(paths=[str(source)], mode="traditional")
        )
    )
    assert result.entries[0].chunkCount == 3
    index.assert_awaited_once_with(source.resolve(), force=False)
    assert library.list_documents().documents[0].id == "pg-doc"


def test_local_path_guard_and_terms(tmp_path):
    library = KnowledgeLibrary(tmp_path / "store")
    with pytest.raises(ValueError, match="越界"):
        library._path("../../../escape")
    assert terms("火星计划 Agent") == {"火星", "星计", "计划", "agent"}


def test_runtime_routes_library(tmp_path, monkeypatch):
    from personal_agent.runtime import dispatch

    monkeypatch.setenv("PERSONAL_AGENT_VIKING_ROOT", str(tmp_path / "store"))
    assert dispatch(
        {"jsonrpc": "2.0", "id": "kb-list", "method": "knowledge.list", "params": {}}
    )["result"] == {"ok": True, "documents": []}
    assert (
        dispatch(
            {
                "jsonrpc": "2.0",
                "id": "kb-import",
                "method": "knowledge.import",
                "params": {"mode": "invalid", "paths": []},
            }
        )["error"]["code"]
        == "PROTOCOL_INVALID_REQUEST"
    )
