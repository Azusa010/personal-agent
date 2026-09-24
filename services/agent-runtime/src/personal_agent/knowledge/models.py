"""知识库系统核心领域数据模型。"""

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class FileType(StrEnum):
    """支持的知识库文档类型。"""

    PDF = "pdf"
    MARKDOWN = "markdown"
    TXT = "txt"


class ParsedPage(BaseModel):
    """单页解析文本模型。"""

    model_config = ConfigDict(extra="allow")

    page_number: int
    text: str


class ParsedDocument(BaseModel):
    """文档解析结果模型。包含结构化 Markdown 与页码标注。"""

    model_config = ConfigDict(extra="allow")

    source_path: str
    file_name: str
    file_type: FileType
    markdown: str
    page_count: int
    pages: list[ParsedPage] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DocumentChunk(BaseModel):
    """文档结构感知分块模型。"""

    model_config = ConfigDict(extra="allow")

    chunk_index: int
    page_numbers: list[int]
    heading_path: str | None = None
    context_prefix: str | None = None
    raw_text: str
    token_count: int
    dense_embedding: list[float] | None = None
    sparse_vector: dict[str, float] | None = None

    @property
    def augmented_text(self) -> str:
        """获取增强上下文后的完整文本（用于向量化编码与深度语义匹配）。"""
        if self.context_prefix and self.context_prefix.strip():
            return f"{self.context_prefix.strip()}\n\n{self.raw_text}"
        return self.raw_text


class DocumentRecord(BaseModel):
    """documents 表对应的持久化记录模型。"""

    model_config = ConfigDict(extra="allow")

    id: UUID | None = None
    source_path: str
    file_name: str
    file_type: str
    file_size: int
    file_hash: str
    parsed_at: datetime | None = None
    page_count: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class IndexResult(BaseModel):
    """索引操作执行结果。"""

    model_config = ConfigDict(extra="allow")

    document_id: str
    source_path: str
    file_hash: str
    status: str  # "indexed" | "skipped_unchanged" | "updated"
    chunk_count: int = 0
    total_tokens: int = 0
    error: str | None = None
