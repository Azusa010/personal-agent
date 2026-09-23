"""结构感知分块器单元测试。"""

from personal_agent.knowledge.chunker import StructureAwareChunker
from personal_agent.knowledge.models import FileType, ParsedDocument


def test_chunker_token_counting():
    """验证 tiktoken 基础分词计数。"""
    chunker = StructureAwareChunker()
    count = chunker.count_tokens("Hello world, 你好，世界！")
    assert count > 0


def test_heading_path_hierarchy():
    """验证 Markdown 多级标题栈与 heading_path 构造。"""
    md = """# 第1章 AI Agent 基础
Agent 的定义与核心机制。

## 1.1 架构模型
总体架构包含规划、执行与记忆。

### 1.1.1 ReAct 循环
思考、行动与观察的闭环。

## 1.2 工具调用
工具注册与五层安全检查。
"""
    doc = ParsedDocument(
        source_path="/test/arch.md",
        file_name="arch.md",
        file_type=FileType.MARKDOWN,
        markdown=md,
        page_count=1,
    )

    chunker = StructureAwareChunker(max_chunk_tokens=512)
    chunks = chunker.chunk(doc)

    paths = [c.heading_path for c in chunks]
    assert "第1章 AI Agent 基础" in paths
    assert "第1章 AI Agent 基础/1.1 架构模型" in paths
    assert "第1章 AI Agent 基础/1.1 架构模型/1.1.1 ReAct 循环" in paths
    assert "第1章 AI Agent 基础/1.2 工具调用" in paths


def test_page_number_attribution():
    """验证内联页码标记在分块中的归属与追踪。"""
    md = """<!-- page: 1 -->
# 知识库说明
第一页的第一部分内容。

<!-- page: 2 -->
第一页结束，这是第二页的内容。
第二页继续说明系统细节。
"""
    doc = ParsedDocument(
        source_path="/test/paged.md",
        file_name="paged.md",
        file_type=FileType.MARKDOWN,
        markdown=md,
        page_count=2,
    )

    chunker = StructureAwareChunker()
    chunks = chunker.chunk(doc)

    assert len(chunks) >= 2
    assert chunks[0].page_numbers == [1]
    assert 2 in chunks[-1].page_numbers


def test_long_section_split_and_overlap():
    """验证超长段落按 512 token 阈值降级切分且包含滑动窗口重叠。"""
    # 构造一个超过 512 token 的长段落
    paragraph = (
        "过失致人重伤罪是指过失伤害他人身体，致人重伤的行为。"
        "本罪侵犯的客体是他人的身体健康权利。在客观方面表现为因过失致人重伤的行为。"
        "行为人对于自己行为可能造成的损害后果应当预见而没有预见，或者已经预见而轻信能够避免。"
    )
    long_text = "\n\n".join([f"第{i}段：{paragraph}" for i in range(1, 20)])
    md = f"# 法律分析\n\n{long_text}"

    doc = ParsedDocument(
        source_path="/test/law.md",
        file_name="law.md",
        file_type=FileType.MARKDOWN,
        markdown=md,
        page_count=1,
    )

    # 设置较小的 max_chunk_tokens 以严格测试切分
    chunker = StructureAwareChunker(max_chunk_tokens=120, overlap_tokens=20)
    chunks = chunker.chunk(doc)

    assert len(chunks) > 1

    # 验证 chunk_index 连续递增
    for idx, c in enumerate(chunks):
        assert c.chunk_index == idx
        assert c.heading_path == "法律分析"
        assert c.token_count <= 150  # 允许重叠与边界略微溢出，但不超出过大

    # 验证相邻 chunk 存在重叠内容
    c0_tail = chunks[0].raw_text[-18:]
    assert c0_tail in chunks[1].raw_text
