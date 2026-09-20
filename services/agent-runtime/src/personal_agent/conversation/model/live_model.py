"""LiveModel —— 的真实模型适配器（OpenAI Responses API）。

与 ScriptedModel 的分工：ScriptedModel 是 CI 默认实现（CON-006：CI 不得依赖
真实随机模型或付费 API），LiveModel 只在显式配了 OPENAI_MODEL 时才挂上。
两者都实现 ModelGateway，engine 分不出差别；差别在记账——LiveModel 额外实现
UsageReporting，收尾时会往事件流里落一条 model_usage。

结构化输出用 responses.create + 手写 json_schema，而不是 SDK 的 responses.parse：
parse 的 text_format 只收 BaseModel / dataclass，判别联合（ModelDecision 是
Annotated union）进不去；且它固定 strict=True，而 strict 模式不收 arguments /
facts 这类自由对象。手写 schema 用 TypeAdapter(ModelDecision).json_schema() 生成，
合同的单一事实来源仍是 model_gateway 里的那两个模型。

API Key 只由 openai SDK 自己从环境变量读，这里不碰、不打印、不进日志。
"""

from __future__ import annotations

import json
import logging
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
    ThinkingSink,
)
from personal_agent.shared import emit_thinking_chunks

log = logging.getLogger("personal_agent")

# 与 DEP-012 同构：模型名只从这个环境变量读，默认不配。
LIVE_MODEL_ENV = "OPENAI_MODEL"
LIVE_REASONING_SUMMARY_ENV = "OPENAI_REASONING_SUMMARY"

DECISION_ADAPTER: TypeAdapter[ModelDecision] = TypeAdapter(ModelDecision)

# 工具目录：模型能看见的能力 → 参数提示。
# 这份表是「模型这一侧」的说明书，不是能力契约的第二事实来源：真正的参数校验
# 在 host 侧的 argument-binders（Zod）与 HostExecuteToolParams（Python）里，
# 模型传错了会被拒。表里只列参数名与含义，改了不校验的名字只是让提示语失真，
# 不会让错误参数过关。key 必须落在协议 CapabilityId 内，test_live_model 钉着。
TOOL_SPECS: dict[str, str] = {
    "filesystem.list": '列出指定授权根目录下的文件与子目录条目。参数 {"rootId": "<授权根标识，如 downloads>"}',
    "document.extract_pdf": '解析并提取 PDF 文件的逐页文本与页码。参数 {"path": "<目标 PDF 文件的绝对路径>"}',
    "filesystem.create_dir": '在授权根目录下创建新目录。参数 {"path": "<目标目录绝对路径>"}',
    "filesystem.move": '在授权根内移动或重命名文件/目录。参数 {"source": "<源绝对路径>", "target": "<目标绝对路径>"}',
    "scheduler.create": '创建定时提醒任务。参数 {"remindAt": "<ISO-8601 UTC 时间>", "message": "<提醒内容>"}',
    "notification.send": '向宿主桌面发送即时通知。参数 {"reminderId": "<提醒记录ID>"}',
    "terminal.execute": (
        '在安全受限环境下执行终端命令行。参数 {"command": "<命令行文本>", '
        '"cwd": "<可选工作目录>", "timeoutMs": <可选超时毫秒>}'
    ),
}


class LiveModel:
    """Responses API 上的模型网关。

    client 不传就在第一次 decide 时现建（openai.OpenAI() 自己读 OPENAI_API_KEY）：
    构造期不碰网络与密钥，进程启动、握手、ping 都不受模型配置影响，
    配错了也只是这次任务失败，不是整个 runtime 起不来。
    """

    def __init__(
        self,
        model: str,
        client: Any | None = None,
        reasoning_summary: bool | None = None,
    ) -> None:
        self._model = model
        self._client: Any | None = client
        if reasoning_summary is None:
            import os

            self._reasoning_summary = os.environ.get(
                LIVE_REASONING_SUMMARY_ENV, ""
            ).lower() in ("1", "yes", "true")
        else:
            self._reasoning_summary = reasoning_summary
        self._input_tokens = 0
        self._output_tokens = 0
        self._calls = 0

    def decide(
        self,
        context: ModelContext,
        on_thinking: ThinkingSink | None = None,
    ) -> ModelDecision:
        client = self._client_or_create()
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
        decision = self._parse(response)
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

    def _account(self, response: Any) -> None:
        """记账。usage 缺字段按 0 记，不抛：少了统计不该让任务失败。"""
        usage = getattr(response, "usage", None)
        self._calls += 1
        if usage is None:
            return
        self._input_tokens += _as_int(getattr(usage, "input_tokens", 0))
        self._output_tokens += _as_int(getattr(usage, "output_tokens", 0))

    def _parse(self, response: Any) -> ModelDecision:
        text = getattr(response, "output_text", None)
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


DECISION_SCHEMA: dict[str, Any] = DECISION_ADAPTER.json_schema()


def render_input(context: ModelContext) -> str:
    """把 ModelContext 渲染成一次请求的输入文本。

    只列 context.visibleCapabilities 里的能力（Scope 外的能力不下发给模型）。
    本轮计划告诉模型「这轮要做哪几步」，observations 告诉它「已经做到哪一步」——
    两者合起来才是决策依据，单靠任何一个都会跑偏。
    """
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
    return "\n".join(lines)


def _as_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(0, value)


def _describe(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"
