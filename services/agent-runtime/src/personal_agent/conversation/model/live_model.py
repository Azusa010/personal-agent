"""LiveModel —— 真实模型适配器（OpenAI Chat Completions API）。

与 ScriptedModel 的分工：ScriptedModel 是 CI 默认实现（CON-006：CI 不得依赖
真实随机模型或付费 API），LiveModel 只在显式配了 OPENAI_MODEL 时才挂上。
两者都实现 ModelGateway，engine 分不出差别；差别在记账——LiveModel 额外实现
UsageReporting，收尾时会往事件流里落一条 model_usage。

交互协议：
标准多轮会话流 [system, user, assistant, tool]，原生 Function Calling 工具调用。
当模型执行任务时调用工具；当模型完成任务时调用 finish_task 提交总结与页码引用事实。

API Key 只由 openai SDK 自己从环境变量读，这里不碰、不打印、不进日志。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from types import SimpleNamespace
from typing import Any

from openai import OpenAI
from pydantic import TypeAdapter, ValidationError

from personal_agent.conversation.instructions import (
    INSTRUCTIONS,
    compose_instructions,
)
from personal_agent.conversation.model.gateway import (
    ModelCallFailed,
    ModelContext,
    ModelDecision,
    ModelUsage,
    ReplanDecision,
    StepCompleteDecision,
    SummaryDecision,
    ThinkingSink,
    ToolCallDecision,
)
from personal_agent.shared import emit_thinking_chunks

log = logging.getLogger("personal_agent")

LIVE_MODEL_ENV = "OPENAI_MODEL"
LIVE_REASONING_SUMMARY_ENV = "OPENAI_REASONING_SUMMARY"
LIVE_API_PROTOCOL_ENV = "OPENAI_API_PROTOCOL"

DECISION_ADAPTER: TypeAdapter[ModelDecision] = TypeAdapter(ModelDecision)
DECISION_SCHEMA: dict[str, Any] = DECISION_ADAPTER.json_schema()

# 向后兼容说明书（供文字提示与既有测试使用）
TOOL_SPECS: dict[str, str] = {
    "filesystem_list": '列出指定授权根目录下的文件与子目录条目。参数 {"rootId": "<授权根标识，如 downloads>"}',
    "document_extract_pdf": '解析并提取 PDF 文件的逐页文本与页码。参数 {"path": "<目标 PDF 文件的绝对路径>"}',
    "filesystem_create_dir": '在授权根目录下创建新目录。参数 {"path": "<目标目录绝对路径>"}',
    "filesystem_move": '在授权根内移动或重命名文件/目录。参数 {"source": "<源绝对路径>", "target": "<目标绝对路径>"}',
    "scheduler_create": '创建定时提醒任务。参数 {"remindAt": "<ISO-8601 UTC 时间>", "message": "<提醒内容>"}',
    "notification_send": '向宿主桌面发送即时通知。参数 {"reminderId": "<提醒记录ID>"}',
    "terminal_execute": (
        '在安全受限环境下执行终端命令行。参数 {"command": "<命令行文本>", '
        '"cwd": "<可选工作目录>", "timeoutMs": <可选超时毫秒>}'
    ),
    "knowledge_search": (
        '在本地知识库中进行混合语义检索与关键词检索。参数 {"query": "<查询文本>", '
        '"topK": <可选返回条数，默认5>}'
    ),
}

# 标准 OpenAI Function Calling 工具参数定义
TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "filesystem_list": {
        "type": "function",
        "function": {
            "name": "filesystem_list",
            "description": "列出指定授权根目录下的文件与子目录条目",
            "parameters": {
                "type": "object",
                "properties": {
                    "rootId": {
                        "type": "string",
                        "description": "授权根标识，如 downloads",
                    }
                },
                "required": ["rootId"],
            },
        },
    },
    "document_extract_pdf": {
        "type": "function",
        "function": {
            "name": "document_extract_pdf",
            "description": "解析并提取 PDF 文件的逐页文本与页码",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "目标 PDF 文件的绝对路径"}
                },
                "required": ["path"],
            },
        },
    },
    "filesystem_create_dir": {
        "type": "function",
        "function": {
            "name": "filesystem_create_dir",
            "description": "在授权根目录下创建新目录",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "目标目录绝对路径"}
                },
                "required": ["path"],
            },
        },
    },
    "filesystem_move": {
        "type": "function",
        "function": {
            "name": "filesystem_move",
            "description": "在授权根内移动或重命名文件/目录",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {"type": "string", "description": "源绝对路径"},
                    "target": {"type": "string", "description": "目标绝对路径"},
                },
                "required": ["source", "target"],
            },
        },
    },
    "scheduler_create": {
        "type": "function",
        "function": {
            "name": "scheduler_create",
            "description": "创建定时提醒任务",
            "parameters": {
                "type": "object",
                "properties": {
                    "remindAt": {"type": "string", "description": "ISO-8601 UTC 时间"},
                    "message": {"type": "string", "description": "提醒内容"},
                },
                "required": ["remindAt", "message"],
            },
        },
    },
    "notification_send": {
        "type": "function",
        "function": {
            "name": "notification_send",
            "description": "向宿主桌面发送即时通知",
            "parameters": {
                "type": "object",
                "properties": {
                    "reminderId": {"type": "string", "description": "提醒记录ID"}
                },
                "required": ["reminderId"],
            },
        },
    },
    "terminal_execute": {
        "type": "function",
        "function": {
            "name": "terminal_execute",
            "description": "在安全受限环境下执行终端命令行",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的命令行指令"},
                    "cwd": {
                        "type": "string",
                        "description": "可选的工作目录绝对路径",
                    },
                    "timeoutMs": {
                        "type": "integer",
                        "description": "可选的超时时间（毫秒）",
                    },
                },
                "required": ["command"],
            },
        },
    },
    "knowledge_search": {
        "type": "function",
        "function": {
            "name": "knowledge_search",
            "description": "在本地知识库中进行混合语义检索与关键词检索",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "要检索的问题或关键词",
                    },
                    "topK": {
                        "type": "integer",
                        "description": "可选返回的最优候选条数（默认 5）",
                    },
                },
                "required": ["query"],
            },
        },
    },
}

FINISH_TASK_TOOL_NAME = "finish_task"

FINISH_TASK_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": FINISH_TASK_TOOL_NAME,
        "description": "当已完成用户任务的所有必要步骤后调用此工具，提交最终回复给用户，并附带引用事实清单（如有）。",
        "parameters": {
            "type": "object",
            "properties": {
                "reply": {
                    "type": "string",
                    "description": "最终回复用户的自然语言文本内容",
                },
                "facts": {
                    "type": "array",
                    "description": "引用事实列表（若任务涉及文档提取，必须提供引用的事实与页码；否则可为空）",
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {
                                "type": "string",
                                "description": "提取的事实内容陈述",
                            },
                            "pageRefs": {
                                "type": "array",
                                "items": {"type": "integer"},
                                "description": "引用的页码列表，页码从1开始计数",
                            },
                        },
                        "required": ["text"],
                    },
                },
            },
            "required": ["reply"],
        },
    },
}


def build_tools(visible_capabilities: Sequence[str]) -> list[dict[str, Any]]:
    """根据可见能力列表构造 tools 参数，并注入收尾工具 finish_task。"""
    tools = [TOOL_SCHEMAS[c] for c in visible_capabilities if c in TOOL_SCHEMAS]
    tools.append(FINISH_TASK_SCHEMA)
    return tools


def render_messages(context: ModelContext) -> list[dict[str, Any]]:
    """把 ModelContext 投影为标准 Chat Completions 的 [system, user, assistant, tool] 消息列表。"""
    messages: list[dict[str, Any]] = []
    # 1. 系统消息
    system_content = compose_instructions(INSTRUCTIONS, context.profile)
    messages.append({"role": "system", "content": system_content})
    # 2. 历史对话消息
    for turn in context.history:
        messages.append({"role": turn.role, "content": turn.text})
    # 3. 本轮信息
    user_lines = [
        f"任务目标：{context.taskGoal}",
        "",
        "本轮计划（按顺序执行，不跳步、不加步）：",
    ]
    if not context.plan:
        user_lines.append("（空）")
    else:
        for index, step in enumerate(context.plan, start=1):
            if step.capability is None:
                user_lines.append(
                    f"{index}. {step.description}（不经工具，最后直接回复用户）"
                )
            else:
                user_lines.append(f"{index}. {step.description}（{step.capability}）")
    if context.progressDocument:
        user_lines.append("")
        user_lines.append(context.progressDocument)
    messages.append({"role": "user", "content": "\n".join(user_lines)})
    for obs in context.observations:
        messages.append(
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": obs.callId,
                        "type": "function",
                        "function": {
                            "name": obs.capability,
                            "arguments": json.dumps(obs.arguments, ensure_ascii=False),
                        },
                    }
                ],
            }
        )
        messages.append(
            {
                "role": "tool",
                "tool_call_id": obs.callId,
                "content": json.dumps(obs.payload, ensure_ascii=False),
            }
        )
    if context.statusBar:
        messages.append({"role": "user", "content": context.statusBar})
    return messages


class LiveModel:
    """双协议模型网关（支持 OpenAI Responses API 与 Chat Completions API）。

    client 不传就在第一次 decide 时现建（openai.OpenAI() 自己读 OPENAI_API_KEY）：
    构造期不碰网络与密钥，进程启动、握手、ping 都不受模型配置影响，
    配错了也只是这次任务失败，不是整个 runtime 起不来。
    """

    def __init__(
        self,
        model: str,
        client: Any | None = None,
        reasoning_summary: bool | None = None,
        api_protocol: str | None = None,
    ) -> None:
        self._model = model
        self._client: Any | None = client
        import os

        if reasoning_summary is None:
            self._reasoning_summary = os.environ.get(
                LIVE_REASONING_SUMMARY_ENV, ""
            ).lower() in ("1", "yes", "true")
        else:
            self._reasoning_summary = reasoning_summary

        if api_protocol is None:
            self._api_protocol = (
                os.environ.get(LIVE_API_PROTOCOL_ENV, "responses").strip().lower()
            )
        else:
            self._api_protocol = api_protocol.strip().lower()

        self._input_tokens = 0
        self._output_tokens = 0
        self._calls = 0

    def decide(
        self,
        context: ModelContext,
        on_thinking: ThinkingSink | None = None,
    ) -> ModelDecision:
        client = self._client_or_create()
        if self._api_protocol == "chat_completions":
            return self._decide_chat_completions(client, context, on_thinking)
        return self._decide_responses(client, context, on_thinking)

    def _decide_responses(
        self,
        client: Any,
        context: ModelContext,
        on_thinking: ThinkingSink | None = None,
    ) -> ModelDecision:
        text_config = {
            "format": {
                "type": "json_schema",
                "name": "model_decision",
                "strict": False,
                "schema": DECISION_SCHEMA,
            }
        }
        instructions = compose_instructions(INSTRUCTIONS, context.profile)
        enable_reasoning = (
            context.profile.reasoningSummary
            if context.profile and context.profile.reasoningSummary is not None
            else self._reasoning_summary
        )
        streamed_chunks = 0
        try:
            if enable_reasoning:
                with client.responses.stream(
                    model=self._model,
                    instructions=instructions,
                    input=render_input(context),
                    text=text_config,
                    store=False,
                    reasoning={"summary": "auto"},
                ) as stream:
                    for event in stream:
                        ev_type = getattr(event, "type", None)
                        if ev_type in (
                            "response.reasoning_summary_text.delta",
                            "response.reasoning_text.delta",
                            "response.reasoning.delta",
                        ):
                            delta = getattr(event, "delta", "")
                            if delta and on_thinking is not None:
                                on_thinking(delta)
                                streamed_chunks += 1
                    response = stream.get_final_response()
            else:
                response = client.responses.create(
                    model=self._model,
                    instructions=instructions,
                    input=render_input(context),
                    text=text_config,
                    store=False,
                )
        except ModelCallFailed:
            raise
        except Exception as e:
            raise ModelCallFailed(f"模型调用失败: {_describe(e)}") from e
        self._account(response)
        decision = self._parse_responses(response)
        if (
            streamed_chunks == 0
            and on_thinking is not None
            and getattr(decision, "thinking", None)
        ):
            emit_thinking_chunks(decision.thinking, on_thinking, 0.02)
        return decision

    def _decide_chat_completions(
        self,
        client: Any,
        context: ModelContext,
        on_thinking: ThinkingSink | None = None,
    ) -> ModelDecision:
        messages = render_messages(context)
        tools = build_tools(context.visibleCapabilities)
        enable_reasoning = (
            context.profile.reasoningSummary
            if context.profile and context.profile.reasoningSummary is not None
            else self._reasoning_summary
        )
        streamed_chunks = 0
        try:
            if enable_reasoning:
                stream_res = client.chat.completions.create(
                    model=self._model,
                    messages=messages,
                    tools=tools,
                    stream=True,
                )
                if hasattr(stream_res, "__enter__"):
                    with stream_res as stream:
                        response, streamed_chunks = self._consume_stream(
                            stream, on_thinking
                        )
                else:
                    response, streamed_chunks = self._consume_stream(
                        stream_res, on_thinking
                    )
            else:
                response = client.chat.completions.create(
                    model=self._model,
                    messages=messages,
                    tools=tools,
                )
        except ModelCallFailed:
            raise
        except Exception as e:
            raise ModelCallFailed(f"模型调用失败: {_describe(e)}") from e
        self._account(response)
        decision = self._parse_chat_completions(response)
        if (
            streamed_chunks == 0
            and on_thinking is not None
            and getattr(decision, "thinking", None)
        ):
            emit_thinking_chunks(decision.thinking, on_thinking, 0.02)
        return decision

    def usage_snapshot(self) -> ModelUsage | None:
        """还没调过模型就返回 None：没花 token 的任务不该凭空多一条零用量事件。"""
        if self._calls == 0:
            return None
        return ModelUsage(
            model=self._model,
            inputTokens=self._input_tokens,
            outputTokens=self._output_tokens,
            calls=self._calls,
        )

    # ===== 内部 =====
    def _client_or_create(self) -> OpenAI | None:
        if self._client is not None:
            return self._client
        try:
            from openai import OpenAI
        except ImportError as e:  # pragma: no cover - 依赖缺失时给出人话
            raise ModelCallFailed(f"openai SDK 不可用: {e}") from e
        try:
            self._client = OpenAI()
        except Exception as e:
            raise ModelCallFailed(f"模型客户端建不起来: {_describe(e)}") from e
        return self._client

    def _consume_stream(
        self, stream: Any, on_thinking: ThinkingSink | None
    ) -> tuple[Any, int]:
        """消费流式响应，抽取思维链，并聚合组装出最终响应。"""
        if hasattr(stream, "get_final_response"):
            final_response = stream.get_final_response()
            count = 0
            for event in stream:
                ev_type = getattr(event, "type", "")
                if ev_type in (
                    "response.reasoning_summary_text.delta",
                    "response.reasoning_text.delta",
                    "response.reasoning.delta",
                ):
                    delta = getattr(event, "delta", "")
                    if delta and on_thinking is not None:
                        on_thinking(delta)
                        count += 1
                elif not ev_type:
                    delta = getattr(event, "reasoning_content", None) or getattr(
                        event, "reasoning", None
                    )
                    if delta and on_thinking is not None:
                        on_thinking(delta)
                        count += 1
            return final_response, count
        count = 0
        accumulated_content = []
        accumulated_tool_calls: dict[int, dict[str, str]] = {}
        finish_reason = "stop"
        for chunk in stream:
            choices = getattr(chunk, "choices", [])
            if not choices:
                continue
            choice = choices[0]
            if getattr(choice, "finish_reason", None):
                finish_reason = choice.finish_reason
            delta = getattr(choices[0], "delta", None)
            if delta is None:
                continue
            reasoning_delta = (
                getattr(delta, "reasoning_content", None)
                or getattr(delta, "reasoning", None)
                or getattr(delta, "reasoning_summary_text", None)
            )
            if reasoning_delta and on_thinking is not None:
                on_thinking(reasoning_delta)
                count += 1

            # 2. 累加正文文本
            if getattr(delta, "content", None):
                accumulated_content.append(delta.content)
            if getattr(delta, "tool_calls", None):
                for tc in delta.tool_calls:
                    idx = getattr(tc, "index", 0)
                    if idx not in accumulated_tool_calls:
                        accumulated_tool_calls[idx] = {
                            "id": getattr(tc, "id", None) or f"call-{idx + 1}",
                            "name": "",
                            "arguments": "",
                        }
                    func = getattr(tc, "function", None)
                    if func:
                        if getattr(func, "name", None):
                            accumulated_tool_calls[idx]["name"] += func.name
                        if getattr(func, "arguments", None):
                            accumulated_tool_calls[idx]["arguments"] += func.arguments
        tool_calls_list = []
        for idx in sorted(accumulated_tool_calls.keys()):
            tc_data = accumulated_tool_calls[idx]
            tool_calls_list.append(
                SimpleNamespace(
                    id=tc_data["id"],
                    type="function",
                    function=SimpleNamespace(
                        name=tc_data["name"],
                        arguments=tc_data["arguments"],
                    ),
                )
            )
        complete_message = SimpleNamespace(
            role="assistant",
            content="".join(accumulated_content) if accumulated_content else None,
            tool_calls=tool_calls_list if tool_calls_list else None,
        )
        final_completion = SimpleNamespace(
            choices=[
                SimpleNamespace(message=complete_message, finish_reason=finish_reason)
            ]
        )
        return final_completion, count

    def _account(self, response: Any) -> None:
        """记账。兼容 Responses API 与 Chat Completions。"""
        usage = getattr(response, "usage", None)
        self._calls += 1
        if usage is None:
            return
        prompt_tokens = getattr(usage, "prompt_tokens", None)
        if prompt_tokens is None:
            prompt_tokens = getattr(usage, "input_tokens", 0)
        completion_tokens = getattr(usage, "completion_tokens", None)
        if completion_tokens is None:
            completion_tokens = getattr(usage, "output_tokens", 0)
        self._input_tokens += _as_int(prompt_tokens)
        self._output_tokens += _as_int(completion_tokens)

    def _parse(self, response: Any) -> ModelDecision:
        """根据响应结构自动分流解析为 ModelDecision。"""
        if hasattr(response, "output_text") or (
            isinstance(response, dict) and "output_text" in response
        ):
            return self._parse_responses(response)
        return self._parse_chat_completions(response)

    def _parse_responses(self, response: Any) -> ModelDecision:
        """从 Responses API response 中解析并验证 ModelDecision。"""
        text = (
            response.get("output_text")
            if isinstance(response, dict)
            else getattr(response, "output_text", None)
        )
        if not isinstance(text, str) or not text.strip():
            raise ModelCallFailed("模型没有给出文本输出（output_text 为空）")
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as e:
            raise ModelCallFailed(f"模型输出不是合法 JSON: {e}") from e
        try:
            return DECISION_ADAPTER.validate_python(raw)
        except ValidationError as e:
            raise ModelCallFailed(f"模型输出不符合 ModelDecision 契约: {e}") from e

    def _parse_chat_completions(self, response: Any) -> ModelDecision:
        """从 Chat Completions response 中分流解析出 ModelDecision。"""
        if isinstance(response, dict):
            choices = response.get("choices", None)
        else:
            choices = getattr(response, "choices", None)
        if not choices or not isinstance(choices, list):
            raise ModelCallFailed("模型响应中缺少 choices 列表")
        message = getattr(choices[0], "message", None)
        if message is None:
            raise ModelCallFailed("模型响应 choices[0] 中缺少 message")

        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls and len(tool_calls) > 0:
            tc = tool_calls[0]
            func = getattr(tc, "function", None)
            func_name = getattr(func, "name", "")
            func_args_raw = getattr(func, "arguments", {})
            try:
                args = (
                    json.loads(func_args_raw)
                    if isinstance(func_args_raw, str)
                    else dict(func_args_raw)
                )
            except Exception as e:
                raise ModelCallFailed(f"工具调用入参不是合法 JSON: {e}") from e
            if func_name == FINISH_TASK_TOOL_NAME:
                reply = args.get("reply")
                if not isinstance(reply, str) or not reply.strip():
                    raise ModelCallFailed("finish_task 调用的 reply 字段不能为空")
                facts = args.get("facts", [])
                if not isinstance(facts, list):
                    facts = []
                return SummaryDecision(
                    kind="summary",
                    reply=reply,
                    facts=facts,
                )
            elif func_name == "step_complete":
                return StepCompleteDecision(
                    kind="step_complete",
                    result=args.get("result", ""),
                )
            elif func_name == "replan":
                return ReplanDecision(
                    kind="replan",
                    reason=args.get("reason", ""),
                )

            call_id = getattr(tc, "id", None) or "call-1"
            return ToolCallDecision(
                kind="tool_call",
                callId=call_id,
                capability=func_name,
                arguments=args,
            )
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            text = content.strip()
            if text.startswith("```"):
                lines = text.splitlines()
                if (
                    len(lines) > -2
                    and lines[0].startswith("```")
                    and lines[-1].startswith("```")
                ):
                    text = "\n".join(lines[1:-1]).strip()

            # 将 JSON 解包为 ModelDecision
            if text.startswith("{") and text.endswith("}"):
                try:
                    raw = json.loads(text)
                    if isinstance(raw, dict) and "kind" in raw:
                        return DECISION_ADAPTER.validate_python(raw)
                except Exception:  # noqa: BLE001, S110
                    pass
        return SummaryDecision(
            kind="summary",
            reply=text,
            facts=[],
        )


def render_input(context: ModelContext) -> str:
    """向后兼容：保留对旧版单段 Prompt 渲染的支持。"""
    lines: list[str] = []
    if context.history:
        lines.append("之前的对话（供理解本轮目标中的指代）：")
        for turn in context.history:
            lines.append(f"[{turn.role}] {turn.text}")
        lines.append("")
    lines.append(f"任务目标：{context.taskGoal}")
    lines.append("")
    lines.append("本轮计划（按顺序执行，不跳步、不加步）：")
    if not context.plan:
        lines.append("（空）")
    for index, step in enumerate(context.plan, start=1):
        if step.capability is None:
            lines.append(f"{index}. {step.description}（不经工具，最后直接回复用户）")
        else:
            lines.append(f"{index}. {step.description}（{step.capability}）")
    if context.progressDocument:
        lines.append("")
        lines.append(context.progressDocument)
    lines.extend(["", "可用能力："])
    visible = [c for c in context.visibleCapabilities if c in TOOL_SPECS]
    if visible:
        lines.append("<available_capabilities>")
        lines.append("本轮可用能力：")
        for c in visible:
            lines.append(f"- {c}: {TOOL_SPECS[c]}")
        lines.append("</available_capabilities>")
    lines.extend(["", "已发生的工具调用："])
    if not context.observations:
        lines.append("（还没有调用过任何工具）")
    for observation in context.observations:
        payload = json.dumps(observation.payload, ensure_ascii=False)
        lines.append(
            f"- {observation.capability} ok={observation.ok} "
            f"callId={observation.callId} 结果={payload}"
        )
    if context.statusBar:
        lines.extend(["", context.statusBar])
    return "\n".join(lines)


def _as_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(0, value)


def _describe(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"
