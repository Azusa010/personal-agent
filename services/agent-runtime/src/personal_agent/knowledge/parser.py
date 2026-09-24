"""知识库文档解析管道。

包含 MinerU PDF 结构化解析器、Markdown/TXT 原生解析器与轻量级 PDF 兜底解析器。
"""

import asyncio
import io
import json
import logging
import os
import re
import time
import zipfile
from abc import ABC, abstractmethod
from pathlib import Path

import pypdf
import requests

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
        content = await asyncio.to_thread(
            path.read_text, encoding="utf-8", errors="replace"
        )

        ext = path.suffix.lower()
        file_type = FileType.MARKDOWN if ext in [".md", ".markdown"] else FileType.TXT

        # 检测内容中是否已有显式页码标记，如 <!-- page: 1 -->
        page_matches = list(
            re.finditer(r"<!--\s*page:\s*(\d+)\s*-->", content, re.IGNORECASE)
        )
        pages: list[ParsedPage] = []

        if page_matches:
            for i, match in enumerate(page_matches):
                start = match.end()
                end = (
                    page_matches[i + 1].start()
                    if i + 1 < len(page_matches)
                    else len(content)
                )
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

    优先通过 MinerU 官方 v4 云端/自建 API 解析复杂版面（表格、公式、标题层级）。
    处理流程遵循官方异步批处理规范：
      1. POST /file-urls/batch 申请预签名上传 URL 及 batch_id；
      2. PUT 直传文件二进制流至预签名对象存储；
      3. 异步轮询 GET /extract-results/batch/{batch_id} 获取状态；
      4. 下载结果 ZIP 并在内存中解压提取 markdown.md 与逐页结构。
    若 MinerU 无法连接且 allow_fallback=True，则平滑降级至 FallbackPdfParser。
    """

    def __init__(
        self,
        api_url: str | None = None,
        api_key: str | None = None,
        allow_fallback: bool = True,
        poll_interval: float = 2.0,
        timeout: float = 120.0,
    ):
        self.api_url = api_url or os.environ.get("MINERU_API_URL")
        self.api_key = api_key or os.environ.get("MINERU_API_KEY")
        self.allow_fallback = allow_fallback
        self.poll_interval = poll_interval
        self.timeout = timeout
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
        """调用 MinerU 官方 v4 API 解析文档。"""

        def _do_post() -> dict:
            if not self.api_key:
                raise RuntimeError("未配置 MINERU_API_KEY，无法调用 MinerU API")

            # 智能规约 API 路由：统一对齐 /api/v4 基础路径
            stripped_url = self.api_url.rstrip("/")
            if "/file-urls/batch" in stripped_url:
                base_url = stripped_url.split("/file-urls/batch")[0]
            elif (
                stripped_url.endswith(("/v4", "/api/v4"))
                or "/v4/" in stripped_url
            ):
                base_url = stripped_url
            elif stripped_url.endswith("/api"):
                base_url = f"{stripped_url}/v4"
            else:
                base_url = f"{stripped_url}/api/v4"

            batch_url = f"{base_url}/file-urls/batch"

            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            }
            data = {
                "files": [
                    {
                        "name": path.name,
                        "data_id": path.stem,
                        "is_ocr": True,
                        "enable_formula": True,
                        "enable_table": True,
                    }
                ],
                "model_version": "vlm",
            }

            # 1. 申请上传预签名地址
            req = requests.post(batch_url, headers=headers, json=data, timeout=30)
            if req.status_code != 200:
                raise RuntimeError(
                    f"MinerU 申请上传链接失败 (HTTP {req.status_code}): {req.text}"
                )
            result = req.json()
            if result.get("code") != 0:
                raise RuntimeError(
                    f"申请 MinerU 上传链接失败: {result.get('msg', '未知错误')}"
                )

            batch_data = result.get("data") or {}
            batch_id = batch_data.get("batch_id")
            urls = batch_data.get("file_urls") or []
            if not batch_id or not urls:
                raise RuntimeError(f"MinerU 返回的 batch_id 或 file_urls 为空: {result}")

            # 2. 预签名上传文档（PUT，不添加额外鉴权 Header 避免签名失效）
            with open(path, "rb") as f:
                res_upload = requests.put(urls[0], data=f, timeout=120)
            if res_upload.status_code not in (200, 201):
                raise RuntimeError(
                    f"上传文件至 MinerU 失败 (HTTP {res_upload.status_code}): {res_upload.text}"
                )
            logger.info("文件 %s 成功上传至 MinerU: %s", path.name, urls[0])

            # 3. 异步轮询提取结果
            poll_url = f"{base_url}/extract-results/batch/{batch_id}"
            get_headers = {"Authorization": f"Bearer {self.api_key}"}

            start_time = time.time()
            file_result = None

            while time.time() - start_time < self.timeout:
                time.sleep(self.poll_interval)
                poll_resp = requests.get(poll_url, headers=get_headers, timeout=30)
                if poll_resp.status_code != 200:
                    logger.warning(
                        "查询 MinerU 进度失败 (HTTP %s): %s",
                        poll_resp.status_code,
                        poll_resp.text,
                    )
                    continue

                poll_json = poll_resp.json()
                if poll_json.get("code") != 0:
                    logger.warning("查询 MinerU 进度异常: %s", poll_json.get("msg"))
                    continue

                p_data = poll_json.get("data") or {}
                extract_results = p_data.get("extract_result") or []
                if not extract_results:
                    continue

                matched = next(
                    (
                        r
                        for r in extract_results
                        if r.get("file_name") == path.name
                        or r.get("data_id") == path.stem
                    ),
                    extract_results[0],
                )
                state = matched.get("state")
                if state == "done":
                    file_result = matched
                    break
                elif state == "failed":
                    err = matched.get("err_msg") or "未知错误"
                    raise RuntimeError(f"MinerU 文档解析失败: {err}")
                else:
                    logger.debug("MinerU 正在解析文档 (state=%s)...", state)

            if not file_result:
                raise TimeoutError(f"MinerU 解析超时 (超过 {self.timeout}s)")

            # 4. 下载并解压解析结果 ZIP
            zip_url = file_result.get("full_zip_url")
            if not zip_url:
                return file_result

            zip_resp = requests.get(zip_url, timeout=120)
            if zip_resp.status_code != 200:
                raise RuntimeError(
                    f"下载 MinerU 结果 ZIP 失败 (HTTP {zip_resp.status_code}): {zip_resp.text}"
                )

            markdown_text = ""
            pages_list: list[dict] = []

            with zipfile.ZipFile(io.BytesIO(zip_resp.content)) as zf:
                names = zf.namelist()

                # 提取 markdown 文件 (优先 markdown.md，次选任意 .md)
                md_entry = next(
                    (
                        n
                        for n in names
                        if n.endswith("markdown.md") and not n.startswith("__MACOSX")
                    ),
                    None,
                )
                if not md_entry:
                    md_entry = next(
                        (
                            n
                            for n in names
                            if n.endswith(".md") and not n.startswith("__MACOSX")
                        ),
                        None,
                    )

                if md_entry:
                    markdown_text = zf.read(md_entry).decode("utf-8", errors="replace")

                # 提取结构化页面信息 (content_list.json 优先，其次 middle_json.json)
                content_list_entry = next(
                    (
                        n
                        for n in names
                        if n.endswith("content_list.json")
                        and not n.startswith("__MACOSX")
                    ),
                    None,
                )
                if content_list_entry:
                    try:
                        content_list_data = json.loads(
                            zf.read(content_list_entry).decode(
                                "utf-8", errors="replace"
                            )
                        )
                        page_texts: dict[int, list[str]] = {}
                        for block in content_list_data:
                            p_idx = block.get("page_idx", 0) + 1
                            text = block.get("text") or block.get("table_body") or ""
                            if text:
                                page_texts.setdefault(p_idx, []).append(str(text))

                        for p_num in sorted(page_texts.keys()):
                            pages_list.append(
                                {
                                    "page_number": p_num,
                                    "text": "\n".join(page_texts[p_num]),
                                }
                            )
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                        logger.warning("解析 content_list.json 失败: %s", e)

                if not pages_list:
                    middle_json_entry = next(
                        (
                            n
                            for n in names
                            if n.endswith("middle_json.json")
                            and not n.startswith("__MACOSX")
                        ),
                        None,
                    )
                    if middle_json_entry:
                        try:
                            middle_data = json.loads(
                                zf.read(middle_json_entry).decode(
                                    "utf-8", errors="replace"
                                )
                            )
                            pdf_info = middle_data.get("pdf_info")
                            if isinstance(pdf_info, list):
                                for p_idx, p_obj in enumerate(pdf_info, start=1):
                                    p_blocks = p_obj.get("para_blocks") or []
                                    p_text = "\n".join(
                                        b.get("text", "")
                                        for b in p_blocks
                                        if b.get("text")
                                    )
                                    pages_list.append(
                                        {"page_number": p_idx, "text": p_text}
                                    )
                        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
                            logger.warning("解析 middle_json.json 失败: %s", e)

            return {
                "markdown": markdown_text,
                "pages": pages_list,
                "page_count": len(pages_list) if pages_list else 1,
                "batch_id": batch_id,
            }

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

        pages = [
            ParsedPage(
                page_number=p.get("page_number", i + 1), text=p.get("text", "")
            )
            for i, p in enumerate(raw_pages)
        ]

        # 若未从 JSON 解析出页面，检测 markdown 中是否已有显式页码标记
        if not pages:
            page_matches = list(
                re.finditer(r"<!--\s*page:\s*(\d+)\s*-->", markdown, re.IGNORECASE)
            )
            if page_matches:
                for i, match in enumerate(page_matches):
                    start = match.end()
                    end = (
                        page_matches[i + 1].start()
                        if i + 1 < len(page_matches)
                        else len(markdown)
                    )
                    page_num = int(match.group(1))
                    page_text = markdown[start:end].strip()
                    pages.append(ParsedPage(page_number=page_num, text=page_text))
            elif markdown:
                pages = [ParsedPage(page_number=1, text=markdown)]

        page_count = (
            payload.get("page_count")
            or (len(pages) if pages else 1)
        )

        return ParsedDocument(
            source_path=str(path),
            file_name=path.name,
            file_type=FileType.PDF,
            markdown=markdown,
            page_count=page_count,
            pages=pages,
            metadata={
                "parser": "MinerUParser",
                "api_url": self.api_url,
                "batch_id": resp_json.get("batch_id"),
            },
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
