"""conversation/model/json_parser.py —— 模型输出 JSON 安全容错解析器。

提供 safe_parse_model_json，用于在原生 json.loads 失败（如尾部附带额外文本、
Markdown 围栏、格式轻微破损）时，由 json_repair 容错清洗并保证输出为合法结构体。
"""

import ast
import json
import logging
import re
from typing import Any

import json_repair

from personal_agent.conversation.model.gateway import ModelCallFailed

log = logging.getLogger(__name__)


def parse_tool_call_arguments(raw_args: Any) -> dict[str, Any]:
    """解析工具调用入参，兼容原生 dict、JSON 字符串、修补 JSON、Python 字典/调用语法等。

    当入参为空（如 ""、None、"{}"）时，优雅回退为空字典 {}，不触发 ModelCallFailed。
    """
    if not raw_args:
        return {}
    if isinstance(raw_args, dict):
        return raw_args
    if not isinstance(raw_args, str):
        try:
            return dict(raw_args)
        except (TypeError, ValueError):
            return {}

    text = raw_args.strip()
    if not text or text in ("{}", "None", "null", "undefined", "()"):
        return {}

    # 去除外层函数包裹，如 func_name(path="...") 或 tool(...)
    fn_match = re.match(r"^\w+\s*\((.*)\)\s*$", text, re.DOTALL)
    if fn_match:
        inner = fn_match.group(1).strip()
        if not inner:
            return {}
        text = inner

    # 1. 原生 json.loads
    try:
        val = json.loads(text)
        if isinstance(val, dict):
            return val
    except (json.JSONDecodeError, ValueError, TypeError):
        pass

    # 2. json_repair 直接修复
    try:
        val = json_repair.repair_json(text, return_objects=True)
        if isinstance(val, dict):
            return val
    except Exception:  # noqa: BLE001, S110
        pass

    # 3. 尝试解析 Python 关键字入参，如 path="weekly-03.pdf", rootId="downloads"
    try:
        call_tree = ast.parse(f"dummy({text})")
        if (
            call_tree.body
            and isinstance(call_tree.body[0], ast.Expr)
            and isinstance(call_tree.body[0].value, ast.Call)
        ):
            call_node = call_tree.body[0].value
            res = {}
            for kw in call_node.keywords:
                if kw.arg:
                    res[kw.arg] = ast.literal_eval(kw.value)
            if res:
                return res
    except (SyntaxError, ValueError, TypeError):
        pass

    # 4. 若缺少外层大括号，补齐重试 json_repair
    if not text.startswith("{") and not text.endswith("}"):
        try:
            val = json_repair.repair_json("{" + text + "}", return_objects=True)
            if isinstance(val, dict):
                return val
        except Exception:  # noqa: BLE001, S110
            pass

    # 5. ast.literal_eval
    try:
        val = ast.literal_eval(text)
        if isinstance(val, dict):
            return val
    except (SyntaxError, ValueError, TypeError):
        pass

    raise ModelCallFailed(f"工具调用入参不是合法 JSON: {text}")



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
