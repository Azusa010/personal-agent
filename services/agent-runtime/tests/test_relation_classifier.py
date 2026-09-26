"""OpenViking 知识图谱语义关系分类器 (RelationClassifier) 单元测试。"""

import json

import pytest

from personal_agent.knowledge.relation_classifier import (
    build_relation_assertion_prompt,
    classify_relations,
    parse_relation_assertions,
)
from personal_agent.knowledge.relation_graph import VALID_PREDICATES


def test_build_relation_assertion_prompt():
    """验证 Prompt 注入源文档、候选文档与白名单谓词及纯 JSON 契约。"""
    source_uri = "viking://knowledge/cpu/avx.md"
    source_content = "AVX 引入了 256 位与 512 位向量寄存器，提供更宽的 SIMD 吞吐。"
    candidates = [
        ("viking://knowledge/cpu/sse.md", "SSE 是 Intel 早期 128 位向量指令扩展。"),
        ("viking://knowledge/math/matrix.md", "矩阵乘法与线性代数基础知识。"),
    ]

    prompt = build_relation_assertion_prompt(source_uri, source_content, candidates)

    # 1. 验证源文档与正文注入
    assert source_uri in prompt
    assert source_content in prompt

    # 2. 验证候选列表全部注入
    for c_uri, c_content in candidates:
        assert c_uri in prompt
        assert c_content in prompt

    # 3. 验证主要关系谓词白名单已列在 prompt 中
    for pred in ["extends", "contrasts_with", "precedes"]:
        assert pred in prompt

    # 4. 验证强约束输出 JSON 格式
    assert "JSON" in prompt or "json" in prompt
    assert "predicate" in prompt
    assert "evidence" in prompt


def test_parse_relation_assertions_clean_json():
    """验证标准 JSON 数组输出的解析。"""
    source_uri = "viking://knowledge/cpu/avx.md"
    raw_output = json.dumps(
        [
            {
                "to": "viking://knowledge/cpu/sse.md",
                "predicate": "extends",
                "label": "演进扩展",
                "evidence": ["AVX 在 SSE 基础上扩充到 256 位寄存器"],
                "confidence": 0.95,
            }
        ]
    )

    edges = parse_relation_assertions(raw_output, source_uri)
    assert len(edges) == 1
    edge = edges[0]
    assert edge.from_uri == source_uri
    assert edge.to_uri == "viking://knowledge/cpu/sse.md"
    assert edge.predicate == "extends"
    assert edge.label == "演进扩展"
    assert edge.evidence == ["AVX 在 SSE 基础上扩充到 256 位寄存器"]
    assert edge.confidence == 0.95


def test_parse_relation_assertions_markdown_fences_and_preamble():
    """验证带有 Markdown 代码块包裹与前后闲聊文本的容错解析。"""
    source_uri = "viking://knowledge/cpu/avx.md"
    raw_output = """
你好！经过深度分析，当前文档与候选文档的关系如下：
```json
[
  {
    "to": "viking://knowledge/cpu/sse.md",
    "predicate": "extends",
    "label": "扩展演进",
    "evidence": "单条字符串形式的引文证据",
    "confidence": 0.9
  },
  {
    "to": "viking://knowledge/cpu/arm_neon.md",
    "predicate": "contrasts_with",
    "label": "架构方案对比",
    "evidence": ["ARM NEON 采用不同于 x86 的定长向量思路"],
    "confidence": 0.88
  }
]
```
希望对你的知识织网有所帮助！
"""
    edges = parse_relation_assertions(raw_output, source_uri)
    assert len(edges) == 2

    # 验证单字符串证据被规整为 list[str]
    assert edges[0].from_uri == source_uri
    assert edges[0].to_uri == "viking://knowledge/cpu/sse.md"
    assert edges[0].predicate == "extends"
    assert edges[0].evidence == ["单条字符串形式的引文证据"]

    assert edges[1].to_uri == "viking://knowledge/cpu/arm_neon.md"
    assert edges[1].predicate == "contrasts_with"
    assert edges[1].confidence == 0.88


def test_parse_relation_assertions_filtering_and_edge_cases():
    """验证异常情况防护：自环过滤、非白名单谓词过滤、空值与损坏 JSON。"""
    source_uri = "viking://knowledge/cpu/avx.md"

    # 1. 含有自环与非法谓词的响应
    raw_output = json.dumps(
        [
            # 自环边 (应当过滤)
            {
                "to": "viking://knowledge/cpu/avx.md",
                "predicate": "extends",
                "label": "自己扩展自己",
            },
            # 非白名单非法谓词 (应当过滤)
            {
                "to": "viking://knowledge/cpu/sse.md",
                "predicate": "invented_by_intel",
                "label": "非标准谓词",
            },
            # 缺失 to 的非法对象 (应当过滤)
            {
                "to": "",
                "predicate": "extends",
            },
            # 非 dict 元素 (应当过滤)
            "not_a_dict_item",
            # 合法边 (保留)
            {
                "to": "viking://knowledge/cpu/sse.md",
                "predicate": "extends",
                "label": "合法边",
                "evidence": ["合法证据"],
            },
        ]
    )

    edges = parse_relation_assertions(raw_output, source_uri)
    assert len(edges) == 1
    assert edges[0].to_uri == "viking://knowledge/cpu/sse.md"
    assert edges[0].predicate == "extends"
    assert edges[0].predicate in VALID_PREDICATES

    # 2. 空文本或纯损坏文本
    assert parse_relation_assertions("", source_uri) == []
    assert parse_relation_assertions("纯文本，没有任何json数组", source_uri) == []
    assert parse_relation_assertions("```json\n{ not an array }\n```", source_uri) == []


@pytest.mark.asyncio
async def test_classify_relations_integration():
    """验证高层 classify_relations 异步调用链路整合。"""
    source_uri = "viking://knowledge/cpu/avx.md"
    source_content = "AVX 内容"
    candidates = [("viking://knowledge/cpu/sse.md", "SSE 内容")]

    mock_llm_response = json.dumps(
        [
            {
                "to": "viking://knowledge/cpu/sse.md",
                "predicate": "extends",
                "label": "扩展演进",
                "evidence": ["AVX 扩充了向量宽度"],
                "confidence": 0.96,
            }
        ]
    )

    captured_prompt = []

    async def fake_model_call(prompt: str) -> str:
        captured_prompt.append(prompt)
        return mock_llm_response

    edges = await classify_relations(
        source_uri=source_uri,
        source_content=source_content,
        candidates=candidates,
        model_call=fake_model_call,
    )

    assert len(captured_prompt) == 1
    assert source_uri in captured_prompt[0]
    assert len(edges) == 1
    assert edges[0].predicate == "extends"
    assert edges[0].confidence == 0.96

    # 候选为空时应快速返回空列表，不调用模型
    empty_edges = await classify_relations(
        source_uri=source_uri,
        source_content=source_content,
        candidates=[],
        model_call=fake_model_call,
    )
    assert empty_edges == []
    assert len(captured_prompt) == 1
