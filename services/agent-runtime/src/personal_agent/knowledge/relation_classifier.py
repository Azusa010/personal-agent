"""OpenViking 知识图谱语义关系分类器 (RelationClassifier)

通过大模型两阶段织网第一阶段：对候选节点进行关系判别与语义关系断言，
输出符合 OpenViking 官方白名单规范的结构化关系边集合。
"""

import json
import re
from collections.abc import Awaitable, Callable

from personal_agent.knowledge.relation_graph import (
    VALID_PREDICATES,
    RelationEdge,
)


def build_relation_assertion_prompt(
    source_uri: str,
    source_content: str,
    candidates: list[tuple[str, str]],
) -> str:
    """构建关系断言 Prompt，指导大模型判断当前文档与候选文档间是否存在强语义关系。
    :param source_uri: 当前文档 URI
    :param source_content: 当前文档正文或摘要内容
    :param candidates: 候选文档列表，每项为 (uri, content_or_abstract)
    :returns: 格式化后的 Prompt 字符串
    """
    candidate_blocks = "\n".join(
        f"- URI: {c_uri}\n  内容摘要: {c_text}" for c_uri, c_text in candidates
    )
    allowed = ", ".join(sorted(VALID_PREDICATES))
    return f"""你是一个专业的知识图谱拓扑构建专家。
    请分析当前文档与候选文档集合之间是否存在强语义关联关系。

    【当前文档】
    URI: {source_uri}
    正文/摘要: {source_content}

    【候选文档列表】
    {candidate_blocks}

    【允许的关系谓词白名单】
    {allowed}

    【输出约束】
    仅输出符合以下 JSON Schema 的纯 JSON 数组，严禁包含任何 Markdown 格式以外的闲聊文字：
    [
      {{
        "to": "候选文档URI",
        "predicate": "上述白名单谓词之一",
        "label": "关系说明",
        "evidence": ["支持该关系的引文片段"],
        "confidence": 0.95
      }}
    ]
    若无直接语义关系，必须输出空数组 []。
    """


def parse_relation_assertions(
    raw_output: str,
    source_uri: str,
) -> list[RelationEdge]:
    """解析大模型返回的关系断言文本，并清洗为合法的 RelationEdge 列表。

    契约要求：
    1. 容错提取：剥离 markdown 代码块标记 (如 ```json ... ``` 或 ``` ... ```)；
       若存在多余前后缀，使用正则或字符检索定位最外层的 `[...]` 数组；
    2. 解析防御：若 JSON 解析失败或解析出的不是 list，返回空列表 `[]`（Fail-Closed）；
    3. 逐项清洗与校验：
       - 元素必须是 dict；
       - `to` 目标 URI 必须存在且非空；
       - 自环过滤：若 `to == source_uri`，坚决过滤丢弃；
       - 谓词校验：`predicate` 必须在 `VALID_PREDICATES` 集合中，不在则过滤丢弃；
       - 格式规整：`evidence` 必须为 list[str]，若为单字符串则自动包装为单元素列表；
       - 置信度规整：`confidence` 应为 0.0~1.0 之间的 float，缺失或非法时兜底为 1.0；
       - 标签规整：`label` 为 str，缺失时兜底为空串 `""`；
    4. 构建 RelationEdge(from=source_uri, to=..., ...) 并返回列表。

    :param raw_output: 大模型原始输出字符串
    :param source_uri: 当前文档 URI
    :returns: 清洗验证后的合法 RelationEdge 列表
    """
    if not raw_output or not raw_output.strip():
        return []
    text = raw_output.strip()
    # 剥离 markdown 代码块标记
    match = re.search(r"```(?:json)?\s*(\[[\s\S]*?\])\s*```", text)
    if match:
        text = match.group(1).strip()
    elif "[" in text and "]" in text:
        start = text.find("[")
        end = text.rfind("]") + 1
        text = text[start:end]
    try:
        data = json.loads(text)
        if not isinstance(data, list):
            return []
    except json.JSONDecodeError:
        return []

    valid_edges: list[RelationEdge] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        to_uri = str(item.get("to") or item.get("to_uri") or "").strip()
        if not to_uri or not isinstance(to_uri, str) or to_uri == source_uri:
            continue
        predicate = str(item.get("predicate") or "").strip()
        if predicate not in VALID_PREDICATES:
            continue
        evidence = item.get("evidence", [])
        if isinstance(evidence, str):
            evidence = [evidence]
        elif not isinstance(evidence, list):
            evidence = []
        confidence = float(item.get("confidence", 1.0))
        confidence = max(0.0, min(1.0, confidence))
        label = str(item.get("label", ""))
        valid_edges.append(
            RelationEdge(
                from_uri=source_uri,
                to_uri=to_uri,
                predicate=predicate,
                label=label,
                evidence=evidence,
                confidence=confidence,
            )
        )
    return valid_edges


async def classify_relations(
    source_uri: str,
    source_content: str,
    candidates: list[tuple[str, str]],
    model_call: Callable[[str], Awaitable[str]],
) -> list[RelationEdge]:
    """两阶段织网第一阶段高层包装：调用模型并提炼合规关系边集合。"""
    if not candidates:
        return []
    prompt = build_relation_assertion_prompt(source_uri, source_content, candidates)
    raw_output = await model_call(prompt)
    return parse_relation_assertions(raw_output, source_uri)
