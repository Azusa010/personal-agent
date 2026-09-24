"""文档解析器单元测试。"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from personal_agent.knowledge.models import FileType
from personal_agent.knowledge.parser import (
    FallbackPdfParser,
    MinerUParser,
    TextMarkdownParser,
    get_parser,
)

FIXTURES_PDF = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "tests"
    / "fixtures"
    / "pdfs"
    / "three-page-text.pdf"
)


@pytest.mark.asyncio
async def test_text_markdown_parser_plain(tmp_path: Path):
    """测试 Markdown 与纯文本解析。"""
    md_file = tmp_path / "sample.md"
    md_content = "# 第一章 介绍\n\n这是正文内容。\n\n## 1.1 背景\n\n背景说明。"
    md_file.write_text(md_content, encoding="utf-8")

    parser = TextMarkdownParser()
    doc = await parser.parse(md_file)

    assert doc.file_name == "sample.md"
    assert doc.file_type == FileType.MARKDOWN
    assert doc.page_count == 1
    assert "第一章 介绍" in doc.markdown
    assert len(doc.pages) == 1


@pytest.mark.asyncio
async def test_text_markdown_parser_with_page_markers(tmp_path: Path):
    """测试包含已有页码标记的 Markdown 文件解析。"""
    md_file = tmp_path / "paged.md"
    md_content = (
        "<!-- page: 1 -->\n第一页内容\n<!-- page: 2 -->\n第二页内容\n<!-- page: 3 -->\n第三页内容"
    )
    md_file.write_text(md_content, encoding="utf-8")

    parser = TextMarkdownParser()
    doc = await parser.parse(md_file)

    assert doc.page_count == 3
    assert len(doc.pages) == 3
    assert doc.pages[0].page_number == 1
    assert doc.pages[0].text == "第一页内容"
    assert doc.pages[2].page_number == 3


@pytest.mark.asyncio
async def test_fallback_pdf_parser_with_real_pdf():
    """测试基于真实 fixture PDF 的 FallbackPdfParser 解析。"""
    assert FIXTURES_PDF.is_file(), f"Fixture PDF 不存在: {FIXTURES_PDF}"

    parser = FallbackPdfParser()
    doc = await parser.parse(FIXTURES_PDF)

    assert doc.file_name == "three-page-text.pdf"
    assert doc.file_type == FileType.PDF
    assert doc.page_count == 3
    assert len(doc.pages) == 3
    assert "PersonalAgent fixture page one" in doc.pages[0].text
    assert "PersonalAgent fixture page two" in doc.pages[1].text
    assert "PersonalAgent fixture page three" in doc.pages[2].text
    assert "<!-- page: 1 -->" in doc.markdown
    assert "<!-- page: 2 -->" in doc.markdown
    assert "<!-- page: 3 -->" in doc.markdown


@pytest.mark.asyncio
async def test_mineru_parser_fallback_when_no_api():
    """当未配置 MINERU_API_URL 且允许 fallback 时，无缝降级到 FallbackPdfParser。"""
    parser = MinerUParser(api_url=None, allow_fallback=True)
    doc = await parser.parse(FIXTURES_PDF)
    assert doc.page_count == 3
    assert "PersonalAgent fixture page one" in doc.markdown


import io
import json
import zipfile


def create_dummy_mineru_zip(
    markdown_text: str, content_list: list[dict] | None = None
) -> bytes:
    """在内存中生成包含 markdown.md 与 content_list.json 的 MinerU 结果 ZIP。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("markdown.md", markdown_text.encode("utf-8"))
        if content_list is not None:
            zf.writestr("content_list.json", json.dumps(content_list).encode("utf-8"))
    return buf.getvalue()


@pytest.mark.asyncio
async def test_mineru_parser_simulated_v4_api(tmp_path: Path):
    """模拟 MinerU 官方 v4 完整 4 步异步批处理 API 流程。"""
    sample_pdf = tmp_path / "dummy.pdf"
    sample_pdf.write_bytes(b"%PDF-1.4 dummy content")

    zip_bytes = create_dummy_mineru_zip(
        markdown_text="# 标题\n\nMinerU 提取的段落",
        content_list=[
            {"page_idx": 0, "text": "第1页"},
            {"page_idx": 1, "text": "第2页"},
        ],
    )

    # 1. Mock POST /file-urls/batch
    mock_post_resp = MagicMock()
    mock_post_resp.status_code = 200
    mock_post_resp.json.return_value = {
        "code": 0,
        "msg": "ok",
        "data": {
            "batch_id": "test-batch-001",
            "file_urls": ["https://oss.example.com/upload-target"],
        },
    }

    # 2. Mock PUT upload_url
    mock_put_resp = MagicMock()
    mock_put_resp.status_code = 200

    # 3. Mock GET /extract-results/batch/{batch_id} 与 GET full_zip_url
    mock_poll_resp = MagicMock()
    mock_poll_resp.status_code = 200
    mock_poll_resp.json.return_value = {
        "code": 0,
        "msg": "ok",
        "data": {
            "batch_id": "test-batch-001",
            "extract_result": [
                {
                    "file_name": "dummy.pdf",
                    "state": "done",
                    "full_zip_url": "https://oss.example.com/result.zip",
                }
            ],
        },
    }

    mock_zip_resp = MagicMock()
    mock_zip_resp.status_code = 200
    mock_zip_resp.content = zip_bytes

    def fake_get(url, *args, **kwargs):
        if "result.zip" in url:
            return mock_zip_resp
        return mock_poll_resp

    with (
        patch("requests.post", return_value=mock_post_resp) as mock_post,
        patch("requests.put", return_value=mock_put_resp) as mock_put,
        patch("requests.get", side_effect=fake_get) as mock_get,
    ):
        parser = MinerUParser(
            api_url="https://mineru.net/api/v4",
            api_key="sk-test-token-123",
            allow_fallback=False,
            poll_interval=0.01,
            timeout=5.0,
        )
        doc = await parser.parse(sample_pdf)

        assert doc.file_name == "dummy.pdf"
        assert doc.page_count == 2
        assert "MinerU 提取的段落" in doc.markdown
        assert doc.metadata["parser"] == "MinerUParser"
        assert doc.metadata["batch_id"] == "test-batch-001"
        assert len(doc.pages) == 2
        assert doc.pages[0].page_number == 1
        assert doc.pages[0].text == "第1页"
        assert doc.pages[1].page_number == 2
        assert doc.pages[1].text == "第2页"

        # 验证鉴权请求头格式
        assert mock_post.called
        post_kwargs = mock_post.call_args.kwargs
        assert post_kwargs["headers"]["Authorization"] == "Bearer sk-test-token-123"
        assert post_kwargs["json"]["model_version"] == "vlm"
        assert mock_put.called
        assert mock_get.called


@pytest.mark.asyncio
async def test_mineru_parser_upload_failure_with_fallback(tmp_path: Path):
    """当 MinerU 预签名上传失败且允许 fallback 时，无缝降级到 FallbackPdfParser。"""
    mock_post_resp = MagicMock()
    mock_post_resp.status_code = 200
    mock_post_resp.json.return_value = {
        "code": 0,
        "data": {
            "batch_id": "batch-err",
            "file_urls": ["https://oss.example.com/upload-target"],
        },
    }

    mock_put_resp = MagicMock()
    mock_put_resp.status_code = 500
    mock_put_resp.text = "Internal Server Error"

    with (
        patch("requests.post", return_value=mock_post_resp),
        patch("requests.put", return_value=mock_put_resp),
    ):
        parser = MinerUParser(
            api_url="https://mineru.net",
            api_key="sk-test",
            allow_fallback=True,
        )
        doc = await parser.parse(FIXTURES_PDF)
        assert doc.page_count == 3
        assert "PersonalAgent fixture page one" in doc.markdown
        assert doc.metadata["parser"] == "FallbackPdfParser"


@pytest.mark.asyncio
async def test_mineru_parser_extract_failed_raises_or_fallback(tmp_path: Path):
    """当 MinerU 状态返回 failed 时抛出明确异常或降级。"""
    mock_post_resp = MagicMock()
    mock_post_resp.status_code = 200
    mock_post_resp.json.return_value = {
        "code": 0,
        "data": {
            "batch_id": "batch-fail",
            "file_urls": ["https://oss.example.com/upload-target"],
        },
    }

    mock_put_resp = MagicMock()
    mock_put_resp.status_code = 200

    mock_poll_resp = MagicMock()
    mock_poll_resp.status_code = 200
    mock_poll_resp.json.return_value = {
        "code": 0,
        "data": {
            "extract_result": [
                {
                    "file_name": FIXTURES_PDF.name,
                    "state": "failed",
                    "err_msg": "Corrupted PDF header",
                }
            ]
        },
    }

    with (
        patch("requests.post", return_value=mock_post_resp),
        patch("requests.put", return_value=mock_put_resp),
        patch("requests.get", return_value=mock_poll_resp),
    ):
        # 允许 fallback 时降级
        p_fallback = MinerUParser(
            api_url="https://mineru.net/api/v4",
            api_key="sk-test",
            allow_fallback=True,
            poll_interval=0.01,
        )
        doc = await p_fallback.parse(FIXTURES_PDF)
        assert doc.metadata["parser"] == "FallbackPdfParser"

        # 不允许 fallback 时报错
        p_strict = MinerUParser(
            api_url="https://mineru.net/api/v4",
            api_key="sk-test",
            allow_fallback=False,
            poll_interval=0.01,
        )
        with pytest.raises(RuntimeError, match="MinerU 文档解析失败: Corrupted PDF header"):
            await p_strict.parse(FIXTURES_PDF)


def test_get_parser_dispatch():
    """测试解析器工厂分发逻辑。"""
    p_md = get_parser("doc.md")
    assert isinstance(p_md, TextMarkdownParser)

    p_txt = get_parser("notes.txt")
    assert isinstance(p_txt, TextMarkdownParser)

    p_pdf = get_parser("paper.pdf", prefer_mineru=False)
    assert isinstance(p_pdf, FallbackPdfParser)

    p_mineru = get_parser("paper.pdf", prefer_mineru=True, api_key="test-key")
    assert isinstance(p_mineru, MinerUParser)
    assert p_mineru.api_key == "test-key"

    with pytest.raises(ValueError, match="暂不支持的文件格式"):
        get_parser("archive.zip")
