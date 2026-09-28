"""conversation/model/json_parser.py —— 模型输出 JSON 安全容错解析器。

提供 safe_parse_model_json，用于在原生 json.loads 失败（如尾部附带额外文本、
Markdown 围栏、格式轻微破损）时，由 json_repair 容错清洗并保证输出为合法结构体。
"""

from __future__ import annotations

import json
import logging
from typing import Any

import json_repair

from personal_agent.conversation.model.gateway import ModelCallFailed

log = logging.getLogger(__name__)


def safe_parse_model_json(text: str) -> dict[str, Any] | list[Any]:
    """安全解析模型输出的 JSON 文本，带多层容错与容器类型底线校验。

    :param text: 模型给出的原始文本输出
    :return: 解析后的字典或列表对象
    :raises ModelCallFailed: 文本为空、无法修复或最终类型不是 dict/list 时抛出（带有'不是合法 JSON'说明）
    """
    if not isinstance(text, str) or not text.strip():
        raise ModelCallFailed("模型没有给出文本输出（output_text 为空）")

    try:
        parsed = json.loads(text)
        if not isinstance(parsed, (dict, list)):
            raise ModelCallFailed("模型输出不是合法 JSON（要求为对象或数组）")
        return parsed
    except json.JSONDecodeError as e:
        log.warning("模型输出非标准 JSON，触发 json_repair 修复: %s", e)
        try:
            repaired = json_repair.repair_json(text, return_objects=True)
            if not isinstance(repaired, (dict, list)):
                raise ModelCallFailed("模型输出不是合法 JSON（要求为对象或数组）")
            return repaired
        except Exception as err:
            raise ModelCallFailed(f"模型输出不是合法 JSON: {err}") from err
