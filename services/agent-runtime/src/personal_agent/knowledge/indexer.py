"""知识库端到端索引编排器。

贯穿哈希比对（幂等去重）、文档解析、结构感知分块与 PostgreSQL 持久化。
"""

import hashlib
import logging
from pathlib import Path

import asyncpg

from personal_agent.db.postgres import get_pg_pool
from personal_agent.knowledge.chunker import StructureAwareChunker
from personal_agent.knowledge.models import DocumentRecord, IndexResult
from personal_agent.knowledge.parser import get_parser
from personal_agent.knowledge.repository import (
    batch_insert_chunks,
    delete_chunks_by_document,
    get_document_by_path,
    upsert_document,
)

logger = logging.getLogger(__name__)


def compute_file_sha256(file_path: Path) -> str:
    """计算文件的 SHA-256 哈希值。"""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


class KnowledgeIndexer:
    """知识库索引编排器。"""

    def __init__(
        self,
        pool: asyncpg.Pool | None = None,
        chunker: StructureAwareChunker | None = None,
    ):
        self._pool = pool
        self.chunker = chunker or StructureAwareChunker()

    async def _get_pool(self) -> asyncpg.Pool:
        if self._pool is None:
            self._pool = await get_pg_pool()
        return self._pool

    async def index_file(
        self,
        file_path: str | Path,
        force: bool = False,
    ) -> IndexResult:
        """索引单个文件。

        输入输出契约：
        - 输入：待索引文件路径 file_path，强制覆盖标记 force；
        - 输出：IndexResult，包含状态（indexed / skipped_unchanged / updated）、分块数及总 token 数；
        - 幂等性：当文件未修改（哈希相同）且 force=False 时，必须返回 skipped_unchanged，不重复写入数据库；
        - 一致性：若文件修改重新索引，旧分块必须全量清理并由新分块原子替换。
        - 对应验收测试：tests/test_knowledge_indexer.py
        """
        path = Path(file_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"文件不存在: {path}")

        file_hash = compute_file_sha256(path)
        pool = await self._get_pool()

        # 检查是否已索引过
        existing = await get_document_by_path(pool, str(path))
        if existing and existing.get("file_hash") == file_hash and not force:
            logger.info("文件哈希未变且未指定 force，跳过索引: %s", path.name)
            return IndexResult(
                document_id=str(existing["id"]),
                source_path=str(path),
                file_hash=file_hash,
                status="skipped_unchanged",
                chunk_count=0,
                total_tokens=0,
            )

        # 1. 解析文档
        parser = get_parser(path)
        parsed_doc = await parser.parse(path)

        # 2. 结构感知分块
        chunks = self.chunker.chunk(parsed_doc)
        total_tokens = sum(c.token_count for c in chunks)

        # 3. 持久化至 documents 表
        doc_record = DocumentRecord(
            id=existing["id"] if existing else None,
            source_path=str(path),
            file_name=path.name,
            file_type=parsed_doc.file_type.value,
            file_size=path.stat().st_size,
            file_hash=file_hash,
            page_count=parsed_doc.page_count,
        )
        doc_id = await upsert_document(pool, doc_record)

        # 4. 清理旧分块并批量写入新分块
        if existing:
            await delete_chunks_by_document(pool, doc_id)

        await batch_insert_chunks(pool, doc_id, chunks)

        status = "updated" if existing else "indexed"
        logger.info(
            "文档索引完成 [%s]: %s (chunks=%d, tokens=%d)",
            status,
            path.name,
            len(chunks),
            total_tokens,
        )
        return IndexResult(
            document_id=str(doc_id),
            source_path=str(path),
            file_hash=file_hash,
            status=status,
            chunk_count=len(chunks),
            total_tokens=total_tokens,
        )

    async def index_directory(
        self,
        dir_path: str | Path,
        extensions: list[str] | None = None,
        recursive: bool = True,
        force: bool = False,
    ) -> list[IndexResult]:
        """批量索引目录下的所有受支持文档。"""
        dir_p = Path(dir_path).resolve()
        if not dir_p.is_dir():
            raise NotADirectoryError(f"目录不存在: {dir_p}")

        target_exts = {e.lower() for e in (extensions or [".pdf", ".md", ".txt"])}
        results: list[IndexResult] = []

        pattern = "**/*" if recursive else "*"
        for file in dir_p.glob(pattern):
            if file.is_file() and file.suffix.lower() in target_exts:
                res = await self.index_file(file, force=force)
                results.append(res)

        return results
