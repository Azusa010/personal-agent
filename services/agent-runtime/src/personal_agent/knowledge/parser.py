"""知识库文档解析管道。

包含 MinerU PDF 结构化解析器、Markdown/TXT 原生解析器与轻量级 PDF 兜底解析器。
"""

import asyncio
import json
import logging
import os
import re
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from pathlib import Path

import pypdf

from personal_agent.knowledge.models import (
    FileType,
    ParsedDocument,
    ParsedPage,
)

logger = logging.getLogger(__name__)


class BaseParser(ABC):
    """文档解析器抽象基类。"""

    @abstractmethod
    async def parse(self, file_path: str | Path) -> ParsedDocument:
        """解析指定路径的文件并返回结构化 ParsedDocument。"""


class TextMarkdownParser(BaseParser):
    """原生纯文本与 Markdown 文档解析器。"""

    async def parse(self, file_path: str | Path) -> ParsedDocument:
        path = Path(file_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"文件不存在: {path}")

        # 异步读取文本内容
        content = await asyncio.to_thread(path.read_text, encoding="utf-8", errors="replace")

        ext = path.suffix.lower()
        file_type = FileType.MARKDOWN if ext in [".md", ".markdown"] else FileType.TXT

        # 检测内容中是否已有显式页码标记，如 <!-- page: 1 -->
        page_matches = list(re.finditer(r"<!--\s*page:\s*(\d+)\s*-->", content, re.IGNORECASE))
        pages: list[ParsedPage] = []

        if page_matches:
            for i, match in enumerate(page_matches):
                start = match.end()
                end = page_matches[i + 1].start() if i + 1 < len(page_matches) else len(content)
                page_num = int(match.group(1))
                page_text = content[start:end].strip()
                pages.append(ParsedPage(page_number=page_num, text=page_text))
            page_count = max(p.page_number for p in pages) if pages else 1
        else:
            page_count = 1
            pages.append(ParsedPage(page_number=1, text=content.strip()))

        return ParsedDocument(
            source_path=str(path),
            file_name=path.name,
            file_type=file_type,
            markdown=content,
            page_count=page_count,
            pages=pages,
            metadata={"size_bytes": path.stat().st_size},
        )


class FallbackPdfParser(BaseParser):
    """基于 pypdf 的轻量级 PDF 兜底解析器。

    适用于未启动 MinerU 服务或离线测试环境，按页提取纯文本并插入结构化页码分界标记。
    """

    async def parse(self, file_path: str | Path) -> ParsedDocument:
        path = Path(file_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"PDF 文件不存在: {path}")

        def _read_pdf() -> tuple[list[ParsedPage], str, int]:
            reader = pypdf.PdfReader(str(path))
            pages: list[ParsedPage] = []
            md_lines: list[str] = []

            for idx, page in enumerate(reader.pages, start=1):
                page_text = (page.extract_text() or "").strip()
                pages.append(ParsedPage(page_number=idx, text=page_text))

                # 插入页码标记供后续分块器精准溯源
                md_lines.append(f"<!-- page: {idx} -->\n")
                if page_text:
                    md_lines.append(page_text)
                md_lines.append("\n")

            combined_md = "\n".join(md_lines)
            return pages, combined_md, len(reader.pages)

        pages, markdown_text, page_count = await asyncio.to_thread(_read_pdf)

        return ParsedDocument(
            source_path=str(path),
            file_name=path.name,
            file_type=FileType.PDF,
            markdown=markdown_text,
            page_count=page_count,
            pages=pages,
            metadata={
                "parser": "FallbackPdfParser",
                "size_bytes": path.stat().st_size,
            },
        )


class MinerUParser(BaseParser):
    """MinerU 结构化文档解析器。

    优先通过 HTTP API 或本地 CLI 调用 MinerU 高精度版面识别模型，还原标题层级、表格与公式。
    若 MinerU 无法连接且 allow_fallback=True，则平滑降级至 FallbackPdfParser。
    """

    def __init__(
        self,
        api_url: str | None = None,
        api_key: str | None = None,
        allow_fallback: bool = True,
    ):
        self.api_url = api_url or os.environ.get("MINERU_API_URL")
        self.api_key = api_key or os.environ.get("MINERU_API_KEY")
        self.allow_fallback = allow_fallback
        self._fallback_parser = FallbackPdfParser()

    async def parse(self, file_path: str | Path) -> ParsedDocument:
        path = Path(file_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"文件不存在: {path}")

        if not self.api_url:
            if self.allow_fallback:
                logger.info("未配置 MINERU_API_URL，平滑降级至 FallbackPdfParser")
                return await self._fallback_parser.parse(path)
            raise RuntimeError("未配置 MINERU_API_URL 且未允许 fallback 模式")

        try:
            return await self._call_mineru_api(path)
        except Exception as exc:
            if self.allow_fallback:
                logger.warning(
                    "MinerU API 请求失败 (%s)，降级至 FallbackPdfParser",
                    exc,
                )
                return await self._fallback_parser.parse(path)
            raise RuntimeError(f"MinerU API 解析失败: {exc}") from exc

    async def _call_mineru_api(self, path: Path) -> ParsedDocument:
        """调用 MinerU 远程 HTTP 服务解析文档。"""

        def _do_post() -> dict:
            # 智能补全 API 路由：若已指定具体路径则保留，否则默认请求 /v1/extract
            stripped_url = self.api_url.rstrip("/")
            if re.search(r"/(extract|file_parse|parse)$", stripped_url):
                url = stripped_url
            else:
                url = f"{stripped_url}/v1/extract"

            with open(path, "rb") as f:
                file_bytes = f.read()

            boundary = "----WebKitFormBoundaryPersonalAgentMinerU"
            # 同时兼容 MinerU 不同的表单字段命名习惯 (file / files)
            body = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
                f"Content-Type: application/pdf\r\n\r\n"
            ).encode() + file_bytes + (
                f"\r\n--{boundary}\r\n"
                f'Content-Disposition: form-data; name="files"; filename="{path.name}"\r\n'
                f"Content-Type: application/pdf\r\n\r\n"
            ).encode() + file_bytes + f"\r\n--{boundary}--\r\n".encode()

            headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"

            req = urllib.request.Request(
                url,
                data=body,
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read().decode("utf-8")
                return json.loads(data)

        resp_json = await asyncio.to_thread(_do_post)

        # 兼容 MinerU 多种响应外层包装：直接返回或嵌套在 data / results 中
        if "data" in resp_json and isinstance(resp_json["data"], dict):
            payload = resp_json["data"]
        elif "results" in resp_json and isinstance(resp_json["results"], dict):
            payload = resp_json["results"]
        else:
            payload = resp_json

        markdown = payload.get("markdown") or payload.get("md") or ""
        raw_pages = payload.get("pages") or []
        page_count = payload.get("page_count") or (len(raw_pages) if raw_pages else 1)

        pages = [
            ParsedPage(page_number=p.get("page_number", i + 1), text=p.get("text", ""))
            for i, p in enumerate(raw_pages)
        ]
        if not pages and page_count > 0:
            pages = [ParsedPage(page_number=1, text=markdown)]

        return ParsedDocument(
            source_path=str(path),
            file_name=path.name,
            file_type=FileType.PDF,
            markdown=markdown,
            page_count=page_count,
            pages=pages,
            metadata={"parser": "MinerUParser", "api_url": self.api_url},
        )


def get_parser(
    file_path: str | Path,
    prefer_mineru: bool = True,
    allow_fallback: bool = True,
    api_url: str | None = None,
    api_key: str | None = None,
) -> BaseParser:
    """根据文件类型与环境配置获取适用的文档解析器。"""
    path = Path(file_path)
    ext = path.suffix.lower()

    if ext in [".md", ".markdown", ".txt"]:
        return TextMarkdownParser()
    elif ext == ".pdf":
        if prefer_mineru:
            return MinerUParser(
                api_url=api_url,
                api_key=api_key,
                allow_fallback=allow_fallback,
            )
        return FallbackPdfParser()
    else:
        raise ValueError(f"暂不支持的文件格式: {ext}")
