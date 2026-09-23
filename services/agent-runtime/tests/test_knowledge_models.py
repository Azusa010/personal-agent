"""知识库数据模型单元测试。"""

from uuid import uuid4

from personal_agent.knowledge.models import (
    DocumentChunk,
    DocumentRecord,
    FileType,
    IndexResult,
    ParsedDocument,
    ParsedPage,
)


def test_file_type_enum():
    """验证文档类型枚举值。"""
    assert FileType.PDF == "pdf"
    assert FileType.MARKDOWN == "markdown"
    assert FileType.TXT == "txt"


def test_parsed_document_model():
    """验证解析后文档模型的构建与序列化。"""
    pages = [
        ParsedPage(page_number=1, text="第一页内容"),
        ParsedPage(page_number=2, text="第二页内容"),
    ]
    doc = ParsedDocument(
        source_path="/path/to/test.md",
        file_name="test.md",
        file_type=FileType.MARKDOWN,
        markdown="# 标题\n\n正文内容",
        page_count=2,
        pages=pages,
        metadata={"author": "Azusa", "custom_flag": True},
    )
    assert doc.file_name == "test.md"
    assert doc.page_count == 2
    assert len(doc.pages) == 2
    assert doc.metadata["author"] == "Azusa"

    dumped = doc.model_dump()
    assert dumped["file_type"] == "markdown"
    assert len(dumped["pages"]) == 2


def test_document_chunk_model():
    """验证文档分块模型。"""
    chunk = DocumentChunk(
        chunk_index=0,
        page_numbers=[1],
        heading_path="第1章 概述/1.1 背景",
        raw_text="这是第一块文本内容",
        token_count=18,
    )
    assert chunk.chunk_index == 0
    assert chunk.page_numbers == [1]
    assert chunk.heading_path == "第1章 概述/1.1 背景"
    assert chunk.token_count == 18


def test_document_record_and_index_result():
    """验证文档持久化记录与索引结果模型。"""
    doc_id = uuid4()
    record = DocumentRecord(
        id=doc_id,
        source_path="/test.pdf",
        file_name="test.pdf",
        file_type="pdf",
        file_size=1024,
        file_hash="sha256_mock_hash",
        page_count=3,
    )
    assert record.id == doc_id
    assert record.file_size == 1024

    result = IndexResult(
        document_id=str(doc_id),
        source_path="/test.pdf",
        file_hash="sha256_mock_hash",
        status="indexed",
        chunk_count=5,
        total_tokens=1500,
    )
    assert result.status == "indexed"
    assert result.chunk_count == 5
    assert result.total_tokens == 1500
