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


@pytest.mark.asyncio
async def test_mineru_parser_simulated_api(tmp_path: Path):
    """模拟 MinerU HTTP API 响应。"""
    sample_pdf = tmp_path / "dummy.pdf"
    sample_pdf.write_bytes(b"%PDF-1.4 dummy content")

    fake_response = {
        "markdown": "# 标题\n\n MinerU 提取的段落",
        "page_count": 2,
        "pages": [
            {"page_number": 1, "text": "第1页"},
            {"page_number": 2, "text": "第2页"},
        ],
    }

    mock_resp = MagicMock()
    mock_resp.read.return_value = __import__("json").dumps(fake_response).encode("utf-8")
    mock_resp.__enter__.return_value = mock_resp

    with patch("urllib.request.urlopen", return_value=mock_resp):
        parser = MinerUParser(api_url="http://mineru-service:8000", allow_fallback=False)
        doc = await parser.parse(sample_pdf)

        assert doc.file_name == "dummy.pdf"
        assert doc.page_count == 2
        assert "MinerU 提取的段落" in doc.markdown
        assert doc.metadata["parser"] == "MinerUParser"


@pytest.mark.asyncio
async def test_mineru_parser_with_token_and_nested_data(tmp_path: Path):
    """测试带有 API Token 且返回嵌套 data 结构的 MinerU 响应。"""
    sample_pdf = tmp_path / "research.pdf"
    sample_pdf.write_bytes(b"%PDF-1.4 dummy content")

    fake_response = {
        "code": 0,
        "msg": "ok",
        "data": {
            "markdown": "# 深度学习综述\n\n注意力机制是核心。",
            "pages": [{"page_number": 1, "text": "第1页"}],
        },
    }

    mock_resp = MagicMock()
    mock_resp.read.return_value = __import__("json").dumps(fake_response).encode("utf-8")
    mock_resp.__enter__.return_value = mock_resp

    captured_req = None

    def fake_urlopen(req, timeout):
        nonlocal captured_req
        captured_req = req
        return mock_resp

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        parser = MinerUParser(
            api_url="https://mineru.net/api/v4/extract",
            api_key="sk-test-token-123",
            allow_fallback=False,
        )
        doc = await parser.parse(sample_pdf)

        assert doc.file_name == "research.pdf"
        assert "注意力机制是核心" in doc.markdown
        assert captured_req is not None
        assert captured_req.headers.get("Authorization") == "Bearer sk-test-token-123"
        assert captured_req.full_url == "https://mineru.net/api/v4/extract"


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
