"""LivePlanner —— 让真模型按目标出计划。

与 LiveModel 的分工：LiveModel 在 engine 的循环里决定「下一步做什么」；
LivePlanner 在循环开始之前决定「这一轮总共要做哪几步」。两者共用同一份能力
说明书（TOOL_SPECS）与同一套 Responses API 打法，但互不依赖对方的实例。

契约：
- 出参是 planner.Planner 端口要求的 list[PlanStep]；
- 只允许使用 visibleCapabilities 里出现的能力，名单外的一律让**整份计划作废**
  （fail-closed）。不静默删掉那一步：计划是执行前的合约，删一步等于悄悄降低
  「这次要做什么」的要求，任务会「成功」但没干用户要的事；
- 失败一律抛 ModelCallFailed，由 runtime.handle_make_plan 翻成 PLAN_MODEL_FAILED。

API Key 只由 openai SDK 自己从环境变量读，这里不碰、不打印、不进日志。
"""

import json
import logging
from collections.abc import Sequence
from typing import Any

from openai.types.responses import ResponseTextConfigParam
from pydantic import BaseModel, TypeAdapter, ValidationError

from personal_agent.live_model import TOOL_SPECS
from personal_agent.model_gateway import ModelCallFailed
from personal_agent.planning import PlanStep
from personal_agent.protocol.models import Turn

log = logging.getLogger(__name__)

PLANNER_INSTRUCTIONS = """你是个人助理的规划器：只看目标，产出这一轮要做哪几步。

硬要求：

1. 只能用「可用能力」里列出的能力。不在名单里的能力一律不许出现在计划中，
   也不要发明新的能力名。
2. 计划要覆盖达成目标所必需的步骤，不多不少。只需要回一句话就能答复的目标
   （打招呼、问一件你已经知道的事），就给一步不带 capability 的计划：直接回答。
3. 要读写文件先用 filesystem.list 拿到真实路径——路径只能从它那里来，不许凭
   目标文本推测。
4. 写操作会让用户看到批准面板，可能被拒绝。计划里照常保留这一步，但不要为它
   编造替代方案。
5. 每一步的 description 用中文写清「这一步做什么」。

输出 JSON：

{"steps": [{"description": "<这一步做什么>", "capability": "<能力名>"}, ...]}

不需要工具的那一步（最后直接回答用户）**省略 capability 键**，不要写成 null。"""


class PlannedStep(BaseModel):
    description: str
    capability: str | None = None


class PlanOutput(BaseModel):
    steps: list[PlannedStep]


PLAN_OUTPUT_ADAPTER: TypeAdapter[PlanOutput] = TypeAdapter(PlanOutput)
PLAN_OUTPUT_SCHEMA: dict[str, Any] = PLAN_OUTPUT_ADAPTER.json_schema()


def render_plan_input(
    goal: str, visibleCapabilities: Sequence[str], history: Sequence[Turn] = ()
) -> str:
    """把目标与可用能力渲染成一次规划请求的输入文本。

    只列 visibleCapabilities 里的能力（Scope 外的能力不下发给模型）——与
    live_model.render_input 同一条规矩。
    """
    lines = [f"目标：{goal}", "", "可用能力："]
    if history:
        lines.append("之前的对话（供理解本轮目标中的指代）：")
        for turn in history:
            lines.append(f"[{turn.role}] {turn.text}")
        lines.append("")
    lines.extend([f"目标：{goal}", "", "可用能力："])
    for name in visibleCapabilities:
        lines.append(f"- {name}: {TOOL_SPECS.get(name, '（参数见能力契约）')}")
    return "\n".join(lines)


def clean_plan(
    raw_steps: Sequence[dict[str, Any]], visibleCapabilities: Sequence[str]
) -> list[PlanStep]:
    """
    把模型给的步骤清洗成可接受的计划：只保留 visibleCapabilities 里的能力
    :param raw_steps:
    :param visibleCapabilities:
    :return:
    """
    if not raw_steps:
        raise ModelCallFailed("模型没给出任何步骤")
    visible = set(visibleCapabilities)
    steps: list[PlanStep] = []
    for index, raw in enumerate(raw_steps):
        try:
            step = PlanStep.model_validate(raw)
        except ValidationError as e:
            raise ModelCallFailed(f"计划第 {index} 步结构不合法: {e}") from e
        if step.capability is not None and step.capability not in visibleCapabilities:
            raise ModelCallFailed(
                f"计划第 {index} 步用了不可见的能力 {step.capability}"
                f"（可用：{'、'.join(sorted(visible)) or '无'}）"
            )
        steps.append(step)
    return steps


class LivePlanner:
    """Responses API 上的规划器。

    client 不传就在第一次 plan 时现建（openai.OpenAI() 自己读 OPENAI_API_KEY）：
    构造期不碰网络与密钥，进程启动、握手、ping 都不受模型配置影响，配错了只是
    这次 make_plan 失败，不是整个 runtime 起不来。
    """

    def __init__(self, model: str, client: Any | None = None):
        self._model = model
        self._client = client

    def plan(
        self,
        goal: str,
        visibleCapabilities: Sequence[str],
        history: Sequence[Turn] = (),
    ):
        client = self._client_or_create()
        text: ResponseTextConfigParam = {
            "format": {
                "type": "json_schema",
                "name": "plan_output",
                "strict": False,
                "schema": PLAN_OUTPUT_SCHEMA,
            }
        }
        try:
            response = client.responses.create(
                model=self._model,
                instructions=PLANNER_INSTRUCTIONS,
                input=render_plan_input(goal, visibleCapabilities, history),
                text=text,
                store=False,
            )
        except ModelCallFailed:
            raise
        except Exception as e:
            raise ModelCallFailed(f"规划调用失败: {type(e).__name__}: {e}") from e

        output = self._parse(response)
        return clean_plan(
            [step.model_dump() for step in output.steps], visibleCapabilities
        )

    def _client_or_create(self):
        if self._client is not None:
            return self._client
        try:
            from openai import OpenAI
        except ImportError as e:
            raise ModelCallFailed(f"openai SDK 不可用 {e}") from e
        try:
            self._client = OpenAI()
        except Exception as e:
            raise ModelCallFailed(f"模型客户端建不起来: {type(e).__name__}: {e}") from e
        return self._client

    def _parse(self, response: Any) -> PlanOutput:
        text = getattr(response, "output_text", None)
        if not isinstance(text, str) or not text.strip():
            raise ModelCallFailed("模型没有给出文本输出（output_text 为空）")
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as e:
            raise ModelCallFailed(f"模型输出不是合法 JSON: {e}") from e
        try:
            return PLAN_OUTPUT_ADAPTER.validate_python(raw)
        except ValidationError as e:
            raise ModelCallFailed(f"模型输出不符合 PlanOutput 契约: {e}") from e
