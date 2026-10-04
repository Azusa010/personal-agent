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
import sys
import time
from collections.abc import Sequence
from types import SimpleNamespace
from typing import Any

from openai import OpenAI
from pydantic import TypeAdapter, ValidationError

from personal_agent.conversation.instructions import (
    INSTRUCTIONS,
    compose_instructions,
)
from personal_agent.conversation.model.decision_normalizer import (
    extract_python_code,
    extract_thinking_from_text,
    normalize_raw_decision,
    should_heal_to_code_interpreter,
)
from personal_agent.conversation.model.gateway import (
    BatchToolCallDecision,
    ModelCallFailed,
    ModelContext,
    ModelDecision,
    ModelUsage,
    ReplanDecision,
    StepCompleteDecision,
    SummaryDecision,
    ThinkingSink,
    ToolCallDecision,
    ToolCallItem,
)
from personal_agent.conversation.model.json_parser import (
    parse_tool_call_arguments,
    safe_parse_model_json,
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
    "filesystem_list": (
        '列出指定授权根目录下的文件与子目录条目。参数 {"rootId": "<授权根标识，如 downloads>", '
        '"path": "<可选子目录路径，深入遍历子目录>"}'
    ),
    "document_extract_pdf": '解析并提取 PDF 文件的逐页文本与页码。参数 {"path": "<目标 PDF 文件的绝对路径>"}',
    "read_document": (
        '多格式统一文档读取器，提取逐页文本并支持分页与字符限制。参数 {"path": "<文档相对路径>", '
        '"fileType": "<可选 auto/pdf/docx/pptx/xlsx/text>", "pageStart": <可选起始页，默认1>, '
        '"pageEnd": <可选终止页>, "maxCharsPerPage": <可选每页字符上限，默认4000>}'
    ),
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
    "user_memory_search": (
        '在长期用户记忆中检索相关事实、偏好与历史经历。参数 {"query": "<查询文本>", '
        '"topK": <可选返回条数，默认5>, "category": <可选分类>, "person": <可选人物>}'
    ),
    "viking_read_l0": (
        '读取 Viking 维基条目的 L0 摘要 (.abstract)。参数 {"uri": "<viking:// URI>"}'
    ),
    "viking_read_l1": (
        '读取 Viking 维基目录的 L1 概览 (.overview)。参数 {"uri": "<viking:// URI>"}'
    ),
    "viking_read_l2": (
        '读取 Viking 维基条目的 L2 全文 (*.md)。参数 {"uri": "<viking:// URI>"}'
    ),
    "viking_write_l2": (
        '写入或更新 Viking 维基条目的 L2 全文 (*.md)。参数 {"uri": "<viking:// URI>", "content": "<Markdown文本>"}'
    ),
    "code_interpreter": (
        '在隔离沙盒内运行 Python 代码，用于复杂数据计算、代码推理与自适应热修。'
        '参数 {"code": "<Python代码>", "timeoutMs": <可选超时毫秒数>, "saveArtifacts": <可选布尔>}'
    ),
    "file_search": (
        '跨平台文件/内容检索。参数 {"pattern": "<检索模式>", "searchMode": <可选"filename"|"content_plain"|"content_regex">, "relativeRoot": <可选子路径>, "maxMatches": <可选最大匹配数>}'
    ),
    "skill_search": (
        '按关键词检索可用 Skills 目录。参数 {"query": <可选查询关键词>, "tag": <可选标签>, "maxResults": <可选返回条数>}'
    ),
    "skill_read": (
        '按需加载指定 Skill 的完整说明正文。参数 {"name": "<技能唯一名称>"}'
    ),
    "web_search": (
        "使用 Tavily 搜索引擎执行实时网络搜索，返回结构化网页标题、链接、摘要及答案。"
        '参数 {"query": "<查询关键词>", "maxResults": <可选返回条数，默认5>, '
        '"searchDepth": <可选"basic"|"advanced">, "includeAnswer": <可选布尔，默认false>}'
    ),
    "file_read": (
        '读取指定文件内容，支持行号分页与行号前缀。参数 {"path": "<文件相对路径>", "startLine": <可选起始行>, "endLine": <可选结束行>}'
    ),
    "file_write": (
        '在工作区内写入或完全覆盖文件。参数 {"path": "<文件相对路径>", "content": "<文件内容>"}'
    ),
    "file_edit": (
        '在现有文件中进行精准单块局部修改，Old String 必须全局唯一。参数 {"path": "<文件相对路径>", "oldString": "<待替换文本>", "newString": "<替换后文本>"}'
    ),
    "a2ui_render": (
        '向桌面客户端推送受信任的 A2UI 声明式组件树进行安全渲染与交互。'
        '参数 {"title": "<可选标题>", "components": [<组件列表>], "actions": [<动作列表>]}'
    ),
}

# 标准 OpenAI Function Calling 工具参数定义（由 Pydantic 契约模型动态推导生成，单一事实来源）
from personal_agent.conversation.model.tool_schema_generator import (
    generate_all_tool_schemas,
)

TOOL_SCHEMAS: dict[str, dict[str, Any]] = generate_all_tool_schemas()


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
                    "description": (
                        "引用事实列表。若任务涉及文档提取与总结，必须通读所有已提取页面，提炼全面覆盖各页核心结论、关键指标、时间节点与里程碑的关键要点，每条要点附带准确非空的 pageRefs 页码列表（页码从 1 开始计数）；若非文档提取任务可为空。"
                        "【特别重要】：facts 只能包含从文档页面正文提炼出的事实知识。严禁在 facts 中放入任何工具执行状态或元说明（例如“已创建目录”、“已移动文件”、“已设置提醒”、“挑选了某文件”等，这些必须全部写在 reply 中，严禁作为 fact 放入 facts 列表）！"
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {
                                "type": "string",
                                "description": "提取的事实内容陈述（包含具体关键数据、时间节点或里程碑）",
                            },
                            "pageRefs": {
                                "type": "array",
                                "items": {"type": "integer"},
                                "description": "引用的页码列表，页码从1开始计数，每条事实必须包含至少一个有效页码",
                            },
                        },
                        "required": ["text", "pageRefs"],
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
    if context.systemPrompt:
        system_content = context.systemPrompt
    else:
        system_content = compose_instructions(INSTRUCTIONS, context.profile)
    messages.append({"role": "system", "content": system_content})
    # 2. 历史对话消息
    for turn in context.history:
        messages.append({"role": turn.role, "content": turn.text})
    # 3. 本轮信息
    user_lines = [
        f"任务目标：{context.taskGoal}",
    ]
    if context.userMemories:
        user_lines.append("")
        user_lines.append("【相关用户记忆与偏好】：")
        for mem in context.userMemories:
            user_lines.append(f"- {mem}")
    user_lines.append("")
    user_lines.append("本轮计划（按顺序执行，不跳步、不加步）：")
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
        if context.systemPrompt:
            instructions = context.systemPrompt
        else:
            instructions = compose_instructions(INSTRUCTIONS, context.profile)
        enable_reasoning = (
            context.profile.reasoningSummary
            if context.profile and context.profile.reasoningSummary is not None
            else self._reasoning_summary
        )
        streamed_chunks = 0
        t0 = time.time()
        sys.stderr.write(
            f"\n[LIVE_MODEL] >>> 正在请求模型决策 (model={self._model}, enable_reasoning={enable_reasoning})...\n"
        )
        sys.stderr.flush()
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
                                if streamed_chunks % 15 == 0:
                                    sys.stderr.write(
                                        f"[LIVE_MODEL] 决策思考流式生成中... ({streamed_chunks} chunks)\n"
                                    )
                                    sys.stderr.flush()
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
            sys.stderr.write(f"[LIVE_MODEL] xxx 模型调用异常: {_describe(e)}\n")
            sys.stderr.flush()
            raise ModelCallFailed(f"模型调用失败: {_describe(e)}") from e

        elapsed = time.time() - t0
        sys.stderr.write(f"[LIVE_MODEL] <<< 模型响应接收完成，耗时 {elapsed:.2f}s\n")
        sys.stderr.flush()

        self._account(response)
        decision = self._parse_responses(response, context=context)
        if isinstance(decision, ToolCallDecision):
            sys.stderr.write(f"[LIVE_MODEL] 决策: 调用工具 {decision.capability}\n")
        elif isinstance(decision, BatchToolCallDecision):
            caps = [t.capability for t in decision.calls]
            sys.stderr.write(f"[LIVE_MODEL] 决策: 批量调用工具 {caps}\n")
        elif isinstance(decision, SummaryDecision):
            sys.stderr.write(f"[LIVE_MODEL] 决策: 任务完成 (facts: {len(decision.facts)})\n")
        else:
            sys.stderr.write(f"[LIVE_MODEL] 决策: {type(decision).__name__}\n")
        sys.stderr.flush()
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
        decision = self._parse_chat_completions(response, context=context)
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

    def _parse(
        self, response: Any, context: ModelContext | None = None
    ) -> ModelDecision:
        """根据响应结构自动分流解析为 ModelDecision。"""
        if hasattr(response, "output_text") or (
            isinstance(response, dict) and "output_text" in response
        ):
            return self._parse_responses(response, context=context)
        return self._parse_chat_completions(response, context=context)

    def _parse_responses(
        self, response: Any, context: ModelContext | None = None
    ) -> ModelDecision:
        """从 Responses API response 中解析并验证 ModelDecision。"""
        text = (
            response.get("output_text")
            if isinstance(response, dict)
            else getattr(response, "output_text", None)
        )
        if not isinstance(text, str) or not text.strip():
            raise ModelCallFailed("模型没有给出文本输出（output_text 为空）")

        # 1. 优先检测当前处于代码执行阶段、且直接输出 Python 脚本或代码块的情况
        if should_heal_to_code_interpreter(context):
            extracted = extract_python_code(text)
            if extracted:
                is_json_decision = False
                try:
                    parsed_test = json.loads(text)
                    if isinstance(parsed_test, dict) and parsed_test.get("kind") in (
                        "tool_call",
                        "summary",
                        "step_complete",
                        "replan",
                        "batch_tool_call",
                    ):
                        is_json_decision = True
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
                if not is_json_decision:
                    return ToolCallDecision(
                        kind="tool_call",
                        callId="call-1",
                        capability="code_interpreter",
                        arguments={"code": extracted},
                        thinking=extract_thinking_from_text(text),
                    )

        raw = safe_parse_model_json(text)
        raw = normalize_raw_decision(raw, context=context, raw_text=text)
        try:
            return DECISION_ADAPTER.validate_python(raw)
        except ValidationError as e:
            if should_heal_to_code_interpreter(context):
                extracted = extract_python_code(text)
                if extracted:
                    return ToolCallDecision(
                        kind="tool_call",
                        callId="call-1",
                        capability="code_interpreter",
                        arguments={"code": extracted},
                        thinking=extract_thinking_from_text(text),
                    )
            raise ModelCallFailed(f"模型输出不符合 ModelDecision 契约: {e}") from e

    def _parse_chat_completions(
        self, response: Any, context: ModelContext | None = None
    ) -> ModelDecision:
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
            if len(tool_calls) == 1:
                tc = tool_calls[0]
                func = getattr(tc, "function", None)
                func_name = getattr(func, "name", "")
                func_args_raw = getattr(func, "arguments", {})
                args = parse_tool_call_arguments(func_args_raw)
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
            else:
                items: list[ToolCallItem] = []
                for tc in tool_calls:
                    func = getattr(tc, "function", None)
                    func_name = getattr(func, "name", "")
                    func_args_raw = getattr(func, "arguments", {})
                    args = parse_tool_call_arguments(func_args_raw)
                    call_id = getattr(tc, "id", None) or f"call-{len(items) + 1}"
                    items.append(
                        ToolCallItem(
                            callId=call_id,
                            capability=func_name,
                            arguments=args,
                        )
                    )
                return BatchToolCallDecision(
                    kind="batch_tool_call",
                    calls=items,
                )
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            text = content.strip()
            # 将 JSON 解包为 ModelDecision
            try:
                raw = safe_parse_model_json(text)
                raw = normalize_raw_decision(raw, context=context, raw_text=text)
                if isinstance(raw, dict) and "kind" in raw:
                    return DECISION_ADAPTER.validate_python(raw)
            except Exception:  # noqa: BLE001, S110
                pass
            if should_heal_to_code_interpreter(context):
                extracted = extract_python_code(text)
                if extracted:
                    return ToolCallDecision(
                        kind="tool_call",
                        callId="call-1",
                        capability="code_interpreter",
                        arguments={"code": extracted},
                        thinking=extract_thinking_from_text(text),
                    )
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
    if context.userMemories:
        lines.append("")
        lines.append("【相关用户记忆与偏好】：")
        for mem in context.userMemories:
            lines.append(f"- {mem}")
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
