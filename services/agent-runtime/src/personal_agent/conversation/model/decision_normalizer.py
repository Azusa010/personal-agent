"""conversation/model/decision_normalizer.py —— 模型决策容错归一化器。

当真实 LLM 输出不完全遵循 ModelDecision 契约（例如缺失顶层 kind 判别符、直接输出
工具入参字典、使用 OpenAI Function Calling 字段或单键包裹）时，依据字段特征、
全局工具 Schema 与当前运行上下文（计划步骤、可见能力）智能容错推导，将其规整为
符合 ModelDecision Tagged Union 契约的合法字典。
"""

from __future__ import annotations

import ast
import logging
import re
from typing import Any

from personal_agent.conversation.model.gateway import ModelContext
from personal_agent.conversation.model.tool_schema_generator import (
    generate_all_tool_schemas,
)

log = logging.getLogger(__name__)

# 全局工具 Schema 参数表缓存（capability -> {properties, required}）
_TOOL_SIGNATURES: dict[str, dict[str, set[str]]] = {}


def get_tool_signatures() -> dict[str, dict[str, set[str]]]:
    """获取所有可用能力的参数签名定义（properties 与 required 集合）。"""
    if not _TOOL_SIGNATURES:
        schemas = generate_all_tool_schemas()
        for cap, schema in schemas.items():
            params = schema.get("function", {}).get("parameters", {})
            props = set(params.get("properties", {}).keys())
            req = set(params.get("required", []))
            _TOOL_SIGNATURES[cap] = {"properties": props, "required": req}
    return _TOOL_SIGNATURES


def extract_python_code(text: str) -> str | None:
    """从文本中检测并提取合法的 Python 代码或脚本。

    支持 Markdown 代码块包裹（```python ... ```）以及直接输出的 Python 脚本。
    排除 JSON 结构体、纯常量、纯文本以及非代码内容。
    """
    if not isinstance(text, str) or not text.strip():
        return None
    cleaned = text.strip()

    # 1. 尝试匹配 markdown 代码块
    code_blocks = re.findall(
        r"```(?:python|py)?\s*\n(.*?)\n```", cleaned, re.DOTALL | re.IGNORECASE
    )
    if code_blocks:
        combined = "\n".join(b.strip() for b in code_blocks if b.strip())
        try:
            tree = ast.parse(combined)
            if any(
                not isinstance(stmt, ast.Expr)
                or not isinstance(stmt.value, (ast.Constant, ast.Dict))
                for stmt in tree.body
            ):
                return combined
        except SyntaxError:
            pass

    # 2. 尝试将整个文本作为 Python 代码解析
    try:
        tree = ast.parse(cleaned)
        # 排除纯字典/纯常量（那是 JSON 或纯文本）
        has_real_statement = any(
            isinstance(
                stmt,
                (
                    ast.Assign,
                    ast.AnnAssign,
                    ast.AugAssign,
                    ast.For,
                    ast.While,
                    ast.If,
                    ast.With,
                    ast.FunctionDef,
                    ast.AsyncFunctionDef,
                    ast.ClassDef,
                    ast.Import,
                    ast.ImportFrom,
                    ast.Try,
                ),
            )
            or (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call))
            for stmt in tree.body
        )
        if has_real_statement:
            return cleaned
    except SyntaxError:
        pass

    # 3. 如果包含多行，可能有开头的解释性文字，尝试从第一个具有 Python 语法特征的行开始截取
    lines = cleaned.splitlines()
    code_start_keywords = (
        "import ",
        "from ",
        "def ",
        "class ",
        "for ",
        "while ",
        "with ",
        "print(",
        "#",
    )
    start_idx = None
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if any(stripped.startswith(kw) for kw in code_start_keywords) or (
            re.match(r"^[a-zA-Z_]\w*\s*=", stripped)
            and ("[" in stripped or "{" in stripped or "(" in stripped)
        ):
            start_idx = idx
            break
    if start_idx is not None:
        candidate = "\n".join(lines[start_idx:]).strip()
        try:
            tree = ast.parse(candidate)
            has_real_statement = any(
                isinstance(
                    stmt,
                    (
                        ast.Assign,
                        ast.AnnAssign,
                        ast.AugAssign,
                        ast.For,
                        ast.While,
                        ast.If,
                        ast.With,
                        ast.FunctionDef,
                        ast.AsyncFunctionDef,
                        ast.ClassDef,
                        ast.Import,
                        ast.ImportFrom,
                        ast.Try,
                    ),
                )
                or (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call))
                for stmt in tree.body
            )
            if has_real_statement:
                return candidate
        except SyntaxError:
            pass
    return None


def extract_thinking_from_text(text: str) -> str | None:
    """从文本中提取模型的思考内容（<thinking>标签或代码块前的文字说明）。"""
    if not isinstance(text, str) or not text.strip():
        return None
    # 1. 优先提取显式 <thinking> 标签
    m = re.search(r"<thinking>(.*?)</thinking>", text, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    # 2. 提取 markdown 代码块前的前置说明文本
    m_block = re.search(r"```(?:python|py)?", text, re.IGNORECASE)
    if m_block and m_block.start() > 0:
        prefix = text[: m_block.start()].strip()
        if prefix:
            return prefix
    return None


def should_heal_to_code_interpreter(context: ModelContext | None) -> bool:
    """判断当前运行上下文是否适合将裸 Python 代码自愈为 code_interpreter 调用。"""
    if context is None:
        return True
    # 1. 如果有活跃计划：仅当当前待执行步骤的能力是 code_interpreter 时才自愈为工具调用
    if context.plan:
        obs_count = len(context.observations)
        if obs_count < len(context.plan):
            active_cap = context.plan[obs_count].capability
            return active_cap == "code_interpreter"
        # 步骤全部完成，当前进入收尾阶段，不应静默转为 code_interpreter
        return False
    # 2. 无计划时：只要 code_interpreter 在可见能力列表中即可
    return "code_interpreter" in context.visibleCapabilities


def normalize_raw_decision(
    raw: Any,
    context: ModelContext | None = None,
    raw_text: str | None = None,
) -> Any:
    """将可能缺失 'kind' 或格式变异的模型输出字典归一化为标准的 ModelDecision 字典。

    :param raw: 模型输出解析后的原始对象（dict、list 等）
    :param context: 可选的模型运行上下文（包含 taskGoal, plan, visibleCapabilities 等）
    :param raw_text: 可选的模型原始未解析文本（用于在结构损坏时提取 Python 脚本）
    :return: 归一化后的字典对象（若无法识别则返回原字典交由 Pydantic 严格报错）
    """
    # 兼容传入 list 格式
    if isinstance(raw, list):
        if not raw:
            return raw
        # 若是 dict 列表，归一化为 single tool_call 或 batch_tool_call
        if all(isinstance(x, dict) for x in raw):
            if len(raw) == 1:
                return normalize_raw_decision(
                    raw[0], context=context, raw_text=raw_text
                )
            calls = []
            for idx, item in enumerate(raw, start=1):
                norm_item = normalize_raw_decision(item, context=context)
                if isinstance(norm_item, dict) and norm_item.get("kind") == "tool_call":
                    calls.append(
                        {
                            "callId": norm_item.get("callId", f"call-{idx}"),
                            "capability": norm_item.get("capability", ""),
                            "arguments": norm_item.get("arguments", {}),
                        }
                    )
            if calls:
                return {"kind": "batch_tool_call", "calls": calls}
        # 若不是纯 dict 列表（如 json_repair 将 Python 列表修成了嵌套 list），尝试自愈
        if raw_text and should_heal_to_code_interpreter(context):
            extracted = extract_python_code(raw_text)
            if extracted:
                return {
                    "kind": "tool_call",
                    "callId": "call-1",
                    "capability": "code_interpreter",
                    "arguments": {"code": extracted},
                    "thinking": extract_thinking_from_text(raw_text),
                }
        return raw

    if not isinstance(raw, dict):
        if raw_text and should_heal_to_code_interpreter(context):
            extracted = extract_python_code(raw_text)
            if extracted:
                return {
                    "kind": "tool_call",
                    "callId": "call-1",
                    "capability": "code_interpreter",
                    "arguments": {"code": extracted},
                    "thinking": extract_thinking_from_text(raw_text),
                }
        return raw

    # 1. 若已有合法 kind 判别符，原样透传由 Pydantic 契约严格校验
    kind = raw.get("kind")
    if kind in (
        "tool_call",
        "summary",
        "step_complete",
        "replan",
        "batch_tool_call",
    ):
        return raw

    res = dict(raw)
    thinking = res.get("thinking") or (
        extract_thinking_from_text(raw_text) if raw_text else None
    )

    # 2. 兼容 calls 顶层数组（BatchToolCall）
    calls = res.get("calls")
    if isinstance(calls, list) and calls:
        res["kind"] = "batch_tool_call"
        norm_calls = []
        for idx, call in enumerate(calls, start=1):
            if isinstance(call, dict):
                norm_calls.append(
                    {
                        "callId": call.get("callId") or call.get("id") or f"call-{idx}",
                        "capability": (
                            call.get("capability")
                            or call.get("name")
                            or call.get("tool")
                            or ""
                        ),
                        "arguments": (
                            call.get("arguments")
                            if isinstance(call.get("arguments"), dict)
                            else {
                                k: v
                                for k, v in call.items()
                                if k not in ("callId", "id", "capability", "name", "tool")
                            }
                        ),
                    }
                )
        res["calls"] = norm_calls
        return res

    # 3. 显式带有 capability 字段但缺失 kind
    if "capability" in res and isinstance(res["capability"], str):
        res["kind"] = "tool_call"
        res.setdefault("callId", "call-1")
        if "arguments" not in res:
            res["arguments"] = {
                k: v
                for k, v in res.items()
                if k not in ("kind", "capability", "callId", "thinking")
            }
        elif not isinstance(res["arguments"], dict):
            res["arguments"] = {}
        return res

    # 4. 兼容 OpenAI function calling (name / function) 与 ReAct (tool / action) 格式
    func_obj = res.get("function") if isinstance(res.get("function"), dict) else {}
    tool_name = (
        res.get("tool")
        or res.get("name")
        or res.get("tool_name")
        or func_obj.get("name")
        or res.get("action")
    )
    if isinstance(tool_name, str) and tool_name.strip():
        tool_name = tool_name.strip()
        tool_args = (
            res.get("arguments")
            or res.get("parameters")
            or res.get("args")
            or func_obj.get("arguments")
            or res.get("action_input")
            or res.get("actionInput")
        )
        if tool_args is not None and not isinstance(tool_args, dict):
            from personal_agent.conversation.model.json_parser import (
                parse_tool_call_arguments,
            )

            tool_args = parse_tool_call_arguments(tool_args)
        if not isinstance(tool_args, dict):
            tool_args = {
                k: v
                for k, v in res.items()
                if k
                not in (
                    "tool",
                    "name",
                    "tool_name",
                    "function",
                    "action",
                    "action_input",
                    "actionInput",
                    "kind",
                    "callId",
                    "id",
                    "thinking",
                )
            }

        # 检查是否为 finish_task 收尾工具
        if tool_name == "finish_task":
            return {
                "kind": "summary",
                "reply": tool_args.get("reply", ""),
                "facts": (
                    tool_args.get("facts", [])
                    if isinstance(tool_args.get("facts"), list)
                    else []
                ),
                "thinking": thinking,
            }
        if tool_name == "step_complete":
            return {
                "kind": "step_complete",
                "result": tool_args.get("result", ""),
                "thinking": thinking,
            }
        if tool_name == "replan":
            return {
                "kind": "replan",
                "reason": tool_args.get("reason", ""),
                "thinking": thinking,
            }

        return {
            "kind": "tool_call",
            "callId": res.get("callId") or res.get("id") or "call-1",
            "capability": tool_name,
            "arguments": tool_args,
            "thinking": thinking,
        }

    # 5. 单键字典包裹格式：如 {"terminal_execute": {"command": "..."}}
    signatures = get_tool_signatures()
    non_thinking_keys = [k for k in res if k != "thinking"]
    if len(non_thinking_keys) == 1:
        only_key = non_thinking_keys[0]
        if only_key in signatures:
            inner_val = res[only_key]
            return {
                "kind": "tool_call",
                "callId": "call-1",
                "capability": only_key,
                "arguments": inner_val if isinstance(inner_val, dict) else {},
                "thinking": thinking,
            }

    # 6. 非工具特征字段判定（Summary / StepComplete / Replan）
    tool_param_indicators = {
        "command",
        "code",
        "remindAt",
        "reminderId",
        "rootId",
        "source",
        "target",
        "oldString",
        "newString",
    }
    has_tool_keys = any(k in res for k in tool_param_indicators)

    if not has_tool_keys:
        if "reply" in res and isinstance(res["reply"], str):
            res["kind"] = "summary"
            if not isinstance(res.get("facts"), list):
                res["facts"] = []
            return res
        if "result" in res and isinstance(res["result"], str):
            res["kind"] = "step_complete"
            return res
        if "reason" in res and isinstance(res["reason"], str):
            res["kind"] = "replan"
            return res

    # 7. 裸工具参数字典推导（复现现场 BUG 核心！）
    raw_keys = {k for k in res if k != "thinking"}
    if raw_keys:
        inferred_cap = _infer_capability_from_keys(raw_keys, context, signatures)
        if inferred_cap:
            return {
                "kind": "tool_call",
                "callId": "call-1",
                "capability": inferred_cap,
                "arguments": {k: res[k] for k in raw_keys},
                "thinking": thinking,
            }

    # 8. 若字典未匹配到任何特征，但处于代码执行阶段且 raw_text 提供了可执行 Python 代码：
    if raw_text and should_heal_to_code_interpreter(context):
        extracted = extract_python_code(raw_text)
        if extracted:
            return {
                "kind": "tool_call",
                "callId": "call-1",
                "capability": "code_interpreter",
                "arguments": {"code": extracted},
                "thinking": thinking,
            }

    return raw


def _infer_capability_from_keys(
    keys: set[str],
    context: ModelContext | None,
    signatures: dict[str, dict[str, set[str]]],
) -> str | None:
    """根据入参键集合与上下文推导能力名。"""
    # 1. 优先根据独占特征参数精准直推
    if "command" in keys:
        return "terminal_execute"
    if "code" in keys:
        return "code_interpreter"
    if "remindAt" in keys:
        return "scheduler_create"
    if "reminderId" in keys:
        return "notification_send"
    if "source" in keys and "target" in keys:
        return "filesystem_move"
    if "rootId" in keys:
        return "filesystem_list"
    if "oldString" in keys or "newString" in keys:
        return "file_edit"
    if "uri" in keys:
        if "content" in keys:
            return "viking_write_l2"
        return "viking_read_l0"

    # 2. 候选能力池：如果有 context，优先限定在 visibleCapabilities
    candidate_caps = (
        [c for c in context.visibleCapabilities if c in signatures]
        if context and context.visibleCapabilities
        else list(signatures.keys())
    )

    # 3. 若有计划步骤，优先检查当前活跃步骤的 capability
    if context and context.plan:
        active_cap = None
        obs_count = len(context.observations)
        if obs_count < len(context.plan):
            active_cap = context.plan[obs_count].capability
        if active_cap and active_cap in signatures:
            sig = signatures[active_cap]
            if keys.issubset(sig["properties"]) or (
                sig["required"] and sig["required"].issubset(keys)
            ):
                return active_cap

    # 4. 在候选池中逐一寻找匹配项（keys 是 properties 的子集，且包含必填项）
    matches = []
    for cap in candidate_caps:
        sig = signatures[cap]
        props = sig["properties"]
        req = sig["required"]
        if keys.issubset(props) and (not req or req.issubset(keys)):
            matches.append(cap)

    if len(matches) == 1:
        return matches[0]

    # 若有多项重合（如单个 path 参数），根据计划步骤或偏好排序
    if matches:
        if context and context.plan:
            for step in context.plan:
                if step.capability in matches:
                    return step.capability
        return matches[0]

    return None