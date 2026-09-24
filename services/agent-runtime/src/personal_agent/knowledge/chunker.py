"""基于 Markdown 标题层级的结构感知分块器。

1. 依据 #, ##, ### 标题层级维护状态栈，构造 heading_path；
2. 512 token 阈值递归降级（标题 -> 段落 -> 句子）；
3. 10%（约 50 token）滑动窗口重叠，保障语义连续性；
4. 来源页码 page_numbers 精准溯源；
5. tiktoken 精确计数。
"""

import re
from typing import NamedTuple

import tiktoken

from personal_agent.knowledge.models import DocumentChunk, ParsedDocument


class RawSection(NamedTuple):
    """提取的原始小节数据。"""

    heading_path: str | None
    text: str
    page_numbers: list[int]


class StructureAwareChunker:
    """结构感知递归分块器。"""

    def __init__(
        self,
        max_chunk_tokens: int = 512,
        overlap_tokens: int = 50,
        encoding_name: str = "cl100k_base",
    ):
        self.max_chunk_tokens = max_chunk_tokens
        self.overlap_tokens = overlap_tokens
        self.encoding = tiktoken.get_encoding(encoding_name)

    def count_tokens(self, text: str) -> int:
        """计算指定文本的 token 数量。"""
        return len(self.encoding.encode(text))

    def chunk(self, doc: ParsedDocument) -> list[DocumentChunk]:
        """将 ParsedDocument 递归切分为满足 token 约束的 DocumentChunk 列表。"""
        sections = self._extract_sections(doc.markdown)
        chunks: list[DocumentChunk] = []

        chunk_index = 0
        for sec in sections:
            sec_text = sec.text.strip()
            if not sec_text:
                continue

            sec_tokens = self.count_tokens(sec_text)
            if sec_tokens <= self.max_chunk_tokens:
                chunks.append(
                    DocumentChunk(
                        chunk_index=chunk_index,
                        page_numbers=sec.page_numbers if sec.page_numbers else [1],
                        heading_path=sec.heading_path,
                        raw_text=sec_text,
                        token_count=sec_tokens,
                    )
                )
                chunk_index += 1
            else:
                # 超长小节执行递归切分与滑动窗口重叠
                split_chunks = self._split_section_with_overlap(
                    heading_path=sec.heading_path,
                    text=sec_text,
                    page_numbers=sec.page_numbers,
                    start_chunk_index=chunk_index,
                )
                chunks.extend(split_chunks)
                chunk_index += len(split_chunks)

        return chunks

    def _extract_sections(self, markdown: str) -> list[RawSection]:
        """扫描 Markdown 文本，提取标题层级树与对应正文及页码标注。"""
        lines = markdown.split("\n")
        sections: list[RawSection] = []

        heading_stack: list[tuple[int, str]] = []  # [(level, title)]
        current_lines: list[str] = []
        current_pages: set[int] = set()
        active_page = 1

        heading_pattern = re.compile(r"^(#{1,6})\s+(.+)$")
        page_pattern = re.compile(r"<!--\s*page:\s*(\d+)\s*-->", re.IGNORECASE)

        def _flush_section():
            if current_lines:
                path = "/".join(h[1] for h in heading_stack) if heading_stack else None
                text = "\n".join(current_lines).strip()
                if text:
                    sections.append(
                        RawSection(
                            heading_path=path,
                            text=text,
                            page_numbers=sorted(current_pages) if current_pages else [active_page],
                        )
                    )
                current_lines.clear()
                current_pages.clear()

        for line in lines:
            # 检测内联页码标记
            page_match = page_pattern.search(line)
            if page_match:
                active_page = int(page_match.group(1))
                current_pages.add(active_page)

            # 检测标题标记
            heading_match = heading_pattern.match(line.strip())
            if heading_match:
                _flush_section()
                level = len(heading_match.group(1))
                title = heading_match.group(2).strip()

                # 出栈所有层级大于或等于当前层级的标题
                while heading_stack and heading_stack[-1][0] >= level:
                    heading_stack.pop()

                heading_stack.append((level, title))
                current_pages.add(active_page)
            else:
                if line.strip():
                    current_pages.add(active_page)
                current_lines.append(line)

        _flush_section()
        return sections

    def _split_section_with_overlap(
        self,
        heading_path: str | None,
        text: str,
        page_numbers: list[int],
        start_chunk_index: int,
    ) -> list[DocumentChunk]:
        """对超过 max_chunk_tokens 的小节进行递归切分，并在相邻分块之间保留 overlap_tokens 重叠。"""
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]

        # 细粒度切分成基本片段（若段落超长则按句子切分）
        units: list[str] = []
        for p in paragraphs:
            if self.count_tokens(p) <= self.max_chunk_tokens:
                units.append(p)
            else:
                # 按中英文句末标点细切
                raw_parts = re.split(r"([。！？\n]+|[.!?]+)", p)
                current_sent = ""
                for part in raw_parts:
                    current_sent += part
                    if re.search(r"[。！？\n.!?]", part):
                        if current_sent.strip():
                            units.append(current_sent.strip())
                        current_sent = ""
                if current_sent.strip():
                    units.append(current_sent.strip())

        chunks: list[DocumentChunk] = []
        current_pieces: list[str] = []
        current_tokens = 0
        current_chunk_idx = start_chunk_index

        for unit in units:
            unit_tokens = self.count_tokens(unit)
            # 如果加上当前单元会超出容量且当前已有内容，先落盘当前 chunk
            if current_pieces and (current_tokens + unit_tokens > self.max_chunk_tokens):
                chunk_text = "\n\n".join(current_pieces)
                chunks.append(
                    DocumentChunk(
                        chunk_index=current_chunk_idx,
                        page_numbers=page_numbers if page_numbers else [1],
                        heading_path=heading_path,
                        raw_text=chunk_text,
                        token_count=current_tokens,
                    )
                )
                current_chunk_idx += 1

                # 计算滑动窗口重叠：取尾部片段保留在下一个 chunk 的开头
                overlap_pieces: list[str] = []
                overlap_count = 0
                for piece in reversed(current_pieces):
                    piece_toks = self.count_tokens(piece)
                    if overlap_pieces and (overlap_count + piece_toks > self.overlap_tokens):
                        break
                    overlap_pieces.append(piece)
                    overlap_count += piece_toks
                overlap_pieces.reverse()
                current_pieces = overlap_pieces
                current_tokens = overlap_count

            current_pieces.append(unit)
            current_tokens += unit_tokens

        # 处理收尾剩余的片段
        if current_pieces:
            chunk_text = "\n\n".join(current_pieces)
            chunks.append(
                DocumentChunk(
                    chunk_index=current_chunk_idx,
                    page_numbers=page_numbers if page_numbers else [1],
                    heading_path=heading_path,
                    raw_text=chunk_text,
                    token_count=current_tokens,
                )
            )

        return chunks
